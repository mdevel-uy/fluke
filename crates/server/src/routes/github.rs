//! Routes for the local `gh` CLI-based GitHub integration.
//!
//! These endpoints wrap the `gh` binary already used elsewhere in the
//! backend (see `crates/git-host/src/github/cli.rs`). They expose:
//!
//! Authentication flow:
//! - `GET  /api/github/status` — reports whether the user is authenticated
//!   with `gh` and the state of any in-flight login attempt.
//! - `POST /api/github/login` — starts (or resumes) a `gh auth login` web
//!   flow, captures the one-time code plus verification URL from `gh`'s
//!   output, and returns them to the client for display. Progress can be
//!   polled from the status endpoint.
//!
//! Repository management:
//! - `GET  /api/github/repos` — lists the authenticated user's repos plus
//!   repos from every org they belong to.
//! - `POST /api/github/clone` — clones `<owner>/<repo>` into the local
//!   repos directory, ready to be used as a project path.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, oneshot},
    task,
    time::timeout,
};
use ts_rs::TS;
use utils::{
    assets::asset_dir,
    command_ext::NoWindowExt,
    response::ApiResponse,
    shell::{resolve_executable_path, resolve_executable_path_blocking},
};

use crate::{DeploymentImpl, error::ApiError};

// ============================================================================
// Router
// ============================================================================

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/github/status", get(get_status))
        .route("/github/login", post(post_login))
        .route("/github/repos", get(list_github_repos))
        .route("/github/clone", post(clone_github_repo))
}

// ============================================================================
// Authentication flow (status / login)
// ============================================================================

/// State of the in-progress `gh auth login` flow.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GithubLoginState {
    Pending,
    Completed,
    Failed,
}

/// Progress information for the most recent (or in-flight) login attempt.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GithubLoginProgress {
    pub state: GithubLoginState,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub error: Option<String>,
}

/// Response body for `GET /api/github/status`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GithubStatusResponse {
    pub authenticated: bool,
    pub username: Option<String>,
    pub login: Option<GithubLoginProgress>,
}

/// Response body for `POST /api/github/login`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GithubLoginResponse {
    pub user_code: String,
    pub verification_uri: String,
}

#[derive(Debug, Default)]
struct LoginFlowState {
    progress: Option<GithubLoginProgress>,
    running: bool,
}

static LOGIN_FLOW: OnceLock<Arc<Mutex<LoginFlowState>>> = OnceLock::new();

fn flow_state() -> Arc<Mutex<LoginFlowState>> {
    LOGIN_FLOW
        .get_or_init(|| Arc::new(Mutex::new(LoginFlowState::default())))
        .clone()
}

async fn get_status() -> Result<ResponseJson<ApiResponse<GithubStatusResponse>>, ApiError> {
    let (authenticated, username) = gh_auth_status().await;
    let login = flow_state().lock().await.progress.clone();
    Ok(ResponseJson(ApiResponse::success(GithubStatusResponse {
        authenticated,
        username,
        login,
    })))
}

async fn post_login() -> Result<ResponseJson<ApiResponse<GithubLoginResponse>>, ApiError> {
    if resolve_executable_path("gh").await.is_none() {
        return Err(ApiError::BadRequest(
            "GitHub CLI (`gh`) is not installed or not on PATH".to_string(),
        ));
    }

    let state = flow_state();
    let resp = start_login(state).await?;
    Ok(ResponseJson(ApiResponse::success(resp)))
}

async fn start_login(state: Arc<Mutex<LoginFlowState>>) -> Result<GithubLoginResponse, ApiError> {
    {
        let mut g = state.lock().await;
        if g.running {
            // If a login is already in progress and we've already parsed the
            // code/URL, return the cached values so the client can display them.
            if let Some(prog) = &g.progress
                && let (Some(code), Some(uri)) = (&prog.user_code, &prog.verification_uri)
            {
                return Ok(GithubLoginResponse {
                    user_code: code.clone(),
                    verification_uri: uri.clone(),
                });
            }
            return Err(ApiError::Conflict(
                "A GitHub login is already in progress. Poll /api/github/status to see progress."
                    .to_string(),
            ));
        }
        g.progress = Some(GithubLoginProgress {
            state: GithubLoginState::Pending,
            user_code: None,
            verification_uri: None,
            error: None,
        });
        g.running = true;
    }

    let (tx, rx) = oneshot::channel::<Result<(String, String), String>>();
    let state_task = state.clone();
    tokio::spawn(async move {
        run_gh_login_process(state_task, tx).await;
    });

    match timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(Ok((user_code, verification_uri)))) => Ok(GithubLoginResponse {
            user_code,
            verification_uri,
        }),
        Ok(Ok(Err(msg))) => Err(ApiError::BadGateway(msg)),
        Ok(Err(_)) => Err(ApiError::BadGateway(
            "gh login task terminated before returning a code".to_string(),
        )),
        Err(_) => Err(ApiError::BadGateway(
            "Timed out waiting for `gh auth login` to provide a device code".to_string(),
        )),
    }
}

async fn run_gh_login_process(
    state: Arc<Mutex<LoginFlowState>>,
    ready_tx: oneshot::Sender<Result<(String, String), String>>,
) {
    let mut cmd = Command::new("gh");
    cmd.args([
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
    ]);
    // Prevent gh from launching a browser on the server; the client renders
    // the verification URL itself.
    cmd.env("BROWSER", "true");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.no_window();

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to spawn `gh`: {e}");
            finalize_failure(&state, &msg).await;
            let _ = ready_tx.send(Err(msg));
            return;
        }
    };

    let stderr = child.stderr.take().expect("stderr piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let mut stdin = child.stdin.take().expect("stdin piped");

    let mut ready_tx = Some(ready_tx);
    let mut user_code: Option<String> = None;
    let mut verification_uri: Option<String> = None;
    let mut sent_enter = false;

    let mut merged = MergedLines::new(stderr, stdout);
    while let Some(line) = merged.next_line().await {
        if user_code.is_none() {
            if let Some(code) = parse_user_code(&line) {
                user_code = Some(code);
            }
        }
        if verification_uri.is_none() {
            if let Some(uri) = parse_verification_uri(&line) {
                verification_uri = Some(uri);
            }
        }

        if !sent_enter && line.contains("Press Enter") {
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
            sent_enter = true;
        }

        if ready_tx.is_some() {
            if let (Some(code), Some(uri)) = (user_code.clone(), verification_uri.clone()) {
                {
                    let mut g = state.lock().await;
                    if let Some(p) = g.progress.as_mut() {
                        p.user_code = Some(code.clone());
                        p.verification_uri = Some(uri.clone());
                    }
                }
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Ok((code, uri)));
                }
            }
        }
    }

    // Drop stdin so `gh` sees EOF if it's still reading, then wait.
    drop(stdin);
    let exit_status = child.wait().await;

    let succeeded = matches!(&exit_status, Ok(s) if s.success());
    {
        let mut g = state.lock().await;
        g.running = false;
        let progress = g.progress.get_or_insert_with(|| GithubLoginProgress {
            state: GithubLoginState::Pending,
            user_code: None,
            verification_uri: None,
            error: None,
        });
        match exit_status {
            Ok(s) if s.success() => {
                progress.state = GithubLoginState::Completed;
                progress.error = None;
            }
            Ok(s) => {
                progress.state = GithubLoginState::Failed;
                progress.error = Some(format!("`gh auth login` exited with status {s}"));
            }
            Err(e) => {
                progress.state = GithubLoginState::Failed;
                progress.error = Some(format!("failed to wait for `gh`: {e}"));
            }
        }
    }

    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Err(
            "`gh auth login` exited before emitting a device code".to_string()
        ));
    }

    if succeeded {
        let setup = Command::new("gh")
            .args(["auth", "setup-git"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .output()
            .await;
        if let Err(e) = setup {
            tracing::warn!(?e, "`gh auth setup-git` failed after successful login");
        } else if let Ok(out) = setup
            && !out.status.success()
        {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&out.stderr),
                "`gh auth setup-git` exited unsuccessfully"
            );
        }
    }
}

async fn finalize_failure(state: &Arc<Mutex<LoginFlowState>>, message: &str) {
    let mut g = state.lock().await;
    g.running = false;
    g.progress = Some(GithubLoginProgress {
        state: GithubLoginState::Failed,
        user_code: None,
        verification_uri: None,
        error: Some(message.to_string()),
    });
}

async fn gh_auth_status() -> (bool, Option<String>) {
    if resolve_executable_path("gh").await.is_none() {
        return (false, None);
    }

    let output = Command::new("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .no_window()
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr),
            );
            (true, parse_username(&combined))
        }
        _ => (false, None),
    }
}

fn parse_username(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line
            .trim_start_matches(|c: char| c.is_whitespace() || c == '-' || c == '*' || c == '✓');
        // New format (gh >= 2.40): "Logged in to github.com account USERNAME (…)"
        if let Some(rest) = trimmed
            .strip_prefix("Logged in to github.com account ")
            .or_else(|| trimmed.strip_prefix("Logged in to github.com as "))
        {
            let name = rest.split_whitespace().next()?;
            let clean = name.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
            if !clean.is_empty() {
                return Some(clean.to_string());
            }
        }
    }
    None
}

fn parse_user_code(line: &str) -> Option<String> {
    let idx = line.find("one-time code:")?;
    let after = line[idx + "one-time code:".len()..].trim();
    for token in after.split_whitespace() {
        let clean = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        if is_device_code(clean) {
            return Some(clean.to_string());
        }
    }
    None
}

fn is_device_code(s: &str) -> bool {
    let mut parts = s.split('-');
    let a = parts.next().unwrap_or("");
    let b = parts.next().unwrap_or("");
    if parts.next().is_some() || a.len() != 4 || b.len() != 4 {
        return false;
    }
    a.chars()
        .chain(b.chars())
        .all(|c| c.is_ascii_alphanumeric())
}

fn parse_verification_uri(line: &str) -> Option<String> {
    let marker = "Press Enter to open ";
    let idx = line.find(marker)?;
    let after = &line[idx + marker.len()..];
    let token = after.split_whitespace().next()?;
    if token.starts_with("http") {
        Some(
            token
                .trim_end_matches(|c: char| c == '.' || c == ',' || c == ';')
                .to_string(),
        )
    } else {
        // Older `gh` versions print "github.com" instead of the full URL.
        Some("https://github.com/login/device".to_string())
    }
}

/// Line-buffered reader that merges stderr + stdout so we don't miss any
/// output regardless of where `gh` writes each prompt.
struct MergedLines {
    stderr: tokio::io::Lines<BufReader<tokio::process::ChildStderr>>,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stderr_done: bool,
    stdout_done: bool,
}

impl MergedLines {
    fn new(stderr: tokio::process::ChildStderr, stdout: tokio::process::ChildStdout) -> Self {
        Self {
            stderr: BufReader::new(stderr).lines(),
            stdout: BufReader::new(stdout).lines(),
            stderr_done: false,
            stdout_done: false,
        }
    }

    async fn next_line(&mut self) -> Option<String> {
        loop {
            if self.stderr_done && self.stdout_done {
                return None;
            }
            tokio::select! {
                res = self.stderr.next_line(), if !self.stderr_done => {
                    match res {
                        Ok(Some(line)) => return Some(line),
                        Ok(None) => self.stderr_done = true,
                        Err(_) => self.stderr_done = true,
                    }
                }
                res = self.stdout.next_line(), if !self.stdout_done => {
                    match res {
                        Ok(Some(line)) => return Some(line),
                        Ok(None) => self.stdout_done = true,
                        Err(_) => self.stdout_done = true,
                    }
                }
            }
        }
    }
}

// ============================================================================
// Repository listing and cloning
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitHubRepoSummary {
    pub name_with_owner: String,
    pub visibility: String,
    pub updated_at: Option<DateTime<Utc>>,
    pub description: Option<String>,
    /// Owner login when the repo comes from an organization list;
    /// `None` when it comes from the authenticated user's own repos.
    pub owner_org: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CloneRepoRequest {
    pub name_with_owner: String,
}

#[derive(Debug, Serialize, TS)]
pub struct CloneRepoResponse {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoListItem {
    name_with_owner: String,
    #[serde(default)]
    visibility: String,
    updated_at: Option<DateTime<Utc>>,
    description: Option<String>,
}

const REPO_LIST_JSON_FIELDS: &str = "nameWithOwner,visibility,updatedAt,description";
const REPO_LIST_LIMIT: &str = "200";

async fn list_github_repos() -> Result<ResponseJson<ApiResponse<Vec<GitHubRepoSummary>>>, ApiError>
{
    let repos = task::spawn_blocking(collect_all_repos_blocking)
        .await
        .map_err(|e| ApiError::BadGateway(format!("gh task join failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

fn collect_all_repos_blocking() -> Result<Vec<GitHubRepoSummary>, ApiError> {
    let user_raw = run_gh_blocking(
        &[
            "repo",
            "list",
            "--json",
            REPO_LIST_JSON_FIELDS,
            "--limit",
            REPO_LIST_LIMIT,
        ],
        None,
    )?;
    let user_repos: Vec<GhRepoListItem> = serde_json::from_str(user_raw.trim())
        .map_err(|e| ApiError::BadGateway(format!("Failed to parse `gh repo list` output: {e}")))?;

    let orgs_raw = run_gh_blocking(
        &["api", "user/orgs", "--paginate", "--jq", ".[].login"],
        None,
    )?;
    let orgs: Vec<String> = orgs_raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut summaries: Vec<GitHubRepoSummary> = Vec::new();
    for r in user_repos {
        if seen.insert(r.name_with_owner.clone()) {
            summaries.push(to_summary(r, None));
        }
    }

    for org in &orgs {
        let org_raw = run_gh_blocking(
            &[
                "repo",
                "list",
                org,
                "--json",
                REPO_LIST_JSON_FIELDS,
                "--limit",
                REPO_LIST_LIMIT,
            ],
            None,
        )?;
        let org_repos: Vec<GhRepoListItem> = serde_json::from_str(org_raw.trim()).map_err(|e| {
            ApiError::BadGateway(format!("Failed to parse `gh repo list {org}` output: {e}"))
        })?;
        for r in org_repos {
            if seen.insert(r.name_with_owner.clone()) {
                summaries.push(to_summary(r, Some(org.clone())));
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(summaries)
}

fn to_summary(r: GhRepoListItem, owner_org: Option<String>) -> GitHubRepoSummary {
    GitHubRepoSummary {
        name_with_owner: r.name_with_owner,
        visibility: r.visibility,
        updated_at: r.updated_at,
        description: r.description,
        owner_org,
    }
}

async fn clone_github_repo(
    ResponseJson(payload): ResponseJson<CloneRepoRequest>,
) -> Result<(StatusCode, ResponseJson<ApiResponse<CloneRepoResponse>>), ApiError> {
    let repo_name = validate_name_with_owner(&payload.name_with_owner)?;

    let target = repos_root().join(&repo_name);
    if target.exists() {
        return Err(ApiError::Conflict(format!(
            "Repository already cloned at {}",
            target.display()
        )));
    }
    std::fs::create_dir_all(repos_root())?;

    let name_with_owner = payload.name_with_owner.trim().to_string();
    let target_for_task = target.clone();
    let cloned_path = task::spawn_blocking(move || -> Result<PathBuf, ApiError> {
        let target_str = target_for_task.to_string_lossy().to_string();
        run_gh_blocking(&["repo", "clone", &name_with_owner, &target_str], None)?;
        Ok(target_for_task)
    })
    .await
    .map_err(|e| ApiError::BadGateway(format!("gh task join failed: {e}")))??;

    Ok((
        StatusCode::CREATED,
        ResponseJson(ApiResponse::success(CloneRepoResponse {
            path: cloned_path.to_string_lossy().to_string(),
        })),
    ))
}

fn repos_root() -> PathBuf {
    asset_dir().join("repos")
}

fn validate_name_with_owner(input: &str) -> Result<String, ApiError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest(
            "name_with_owner is required".to_string(),
        ));
    }
    let (owner, name) = trimmed
        .split_once('/')
        .ok_or_else(|| ApiError::BadRequest("Expected 'owner/repo' format".to_string()))?;
    if owner.is_empty() || name.is_empty() {
        return Err(ApiError::BadRequest(
            "Expected 'owner/repo' format".to_string(),
        ));
    }
    if name.contains('/') || trimmed.contains('\\') {
        return Err(ApiError::BadRequest(
            "name_with_owner must not contain path separators".to_string(),
        ));
    }
    if !is_safe_segment(owner) || !is_safe_segment(name) {
        return Err(ApiError::BadRequest(
            "name_with_owner contains unsupported characters".to_string(),
        ));
    }
    Ok(name.to_string())
}

fn is_safe_segment(s: &str) -> bool {
    if s == "." || s == ".." || s.starts_with('-') {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn run_gh_blocking(args: &[&str], dir: Option<&Path>) -> Result<String, ApiError> {
    let gh = resolve_executable_path_blocking("gh").ok_or_else(|| {
        ApiError::BadRequest(
            "GitHub CLI (`gh`) not found in PATH. Install it and run `gh auth login`.".to_string(),
        )
    })?;

    let mut cmd = std::process::Command::new(&gh);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    for a in args {
        cmd.arg(a);
    }

    let output = cmd
        .no_window()
        .output()
        .map_err(|e| ApiError::BadGateway(format!("Failed to spawn gh: {e}")))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(classify_gh_failure(output.status.code(), &stderr))
}

fn classify_gh_failure(exit_code: Option<i32>, stderr: &str) -> ApiError {
    let lower = stderr.to_ascii_lowercase();

    if exit_code == Some(4)
        || lower.contains("authentication failed")
        || lower.contains("must authenticate")
        || lower.contains("bad credentials")
        || lower.contains("gh auth login")
    {
        return ApiError::Unauthorized;
    }

    if lower.contains("403") || lower.contains("forbidden") {
        return ApiError::Forbidden(format!("gh: {stderr}"));
    }

    if lower.contains("no space left on device")
        || lower.contains("disk full")
        || lower.contains("write error: no space")
    {
        return ApiError::BadGateway(format!("Disk full while running gh: {stderr}"));
    }

    if lower.contains("already exists")
        || lower.contains("destination path")
        || lower.contains("fatal: destination")
    {
        return ApiError::Conflict(format!("gh: {stderr}"));
    }

    if lower.contains("could not resolve host")
        || lower.contains("network is unreachable")
        || lower.contains("connection refused")
        || lower.contains("temporary failure in name resolution")
    {
        return ApiError::BadGateway(format!("gh network error: {stderr}"));
    }

    if lower.contains("could not resolve to a repository")
        || lower.contains("404")
        || lower.contains("not found")
    {
        return ApiError::BadRequest(format!("Repository not found or no access: {stderr}"));
    }

    ApiError::BadGateway(format!("gh command failed: {stderr}"))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- auth parsing ----------

    #[test]
    fn parses_device_code() {
        assert_eq!(
            parse_user_code("! First copy your one-time code: ABCD-1234"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(
            parse_user_code("! First copy your one-time code: 08D0-B023 "),
            Some("08D0-B023".to_string())
        );
        assert_eq!(parse_user_code("no code here"), None);
    }

    #[test]
    fn parses_verification_uri() {
        assert_eq!(
            parse_verification_uri(
                "Press Enter to open https://github.com/login/device in your browser..."
            ),
            Some("https://github.com/login/device".to_string())
        );
        assert_eq!(
            parse_verification_uri("Press Enter to open github.com in your browser..."),
            Some("https://github.com/login/device".to_string())
        );
        assert_eq!(parse_verification_uri("something else"), None);
    }

    #[test]
    fn parses_username_new_format() {
        let text = "\
github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
";
        assert_eq!(parse_username(text), Some("octocat".to_string()));
    }

    #[test]
    fn parses_username_legacy_format() {
        let text = "  ✓ Logged in to github.com as octocat (oauth_token)\n";
        assert_eq!(parse_username(text), Some("octocat".to_string()));
    }

    // ---------- name_with_owner validation ----------

    #[test]
    fn accepts_standard_name_with_owner() {
        assert_eq!(validate_name_with_owner("facebook/react").unwrap(), "react");
    }

    #[test]
    fn accepts_dots_and_dashes() {
        assert_eq!(
            validate_name_with_owner("some-org/repo.name-1").unwrap(),
            "repo.name-1"
        );
    }

    #[test]
    fn rejects_missing_slash() {
        assert!(matches!(
            validate_name_with_owner("justarepo"),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(matches!(
            validate_name_with_owner("owner/../evil"),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            validate_name_with_owner("../owner/repo"),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_backslash_and_extra_slash() {
        assert!(matches!(
            validate_name_with_owner("owner\\repo"),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            validate_name_with_owner("owner/sub/repo"),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_empty_or_whitespace() {
        assert!(matches!(
            validate_name_with_owner("   "),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            validate_name_with_owner(""),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_shell_metacharacters() {
        assert!(matches!(
            validate_name_with_owner("owner/repo;rm -rf"),
            Err(ApiError::BadRequest(_))
        ));
    }

    // ---------- gh failure classifier ----------

    #[test]
    fn classifies_auth_failure_by_exit_code() {
        let err = classify_gh_failure(Some(4), "some noise");
        assert!(matches!(err, ApiError::Unauthorized));
    }

    #[test]
    fn classifies_auth_failure_by_stderr() {
        let err = classify_gh_failure(Some(1), "You must authenticate first. Run gh auth login");
        assert!(matches!(err, ApiError::Unauthorized));
    }

    #[test]
    fn classifies_disk_full() {
        let err = classify_gh_failure(Some(1), "fatal: write error: No space left on device");
        assert!(matches!(err, ApiError::BadGateway(_)));
    }

    #[test]
    fn classifies_repo_not_found() {
        let err = classify_gh_failure(
            Some(1),
            "GraphQL: Could not resolve to a Repository with the name 'foo/bar'.",
        );
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    #[test]
    fn classifies_already_exists() {
        let err = classify_gh_failure(
            Some(1),
            "fatal: destination path 'foo' already exists and is not an empty directory.",
        );
        assert!(matches!(err, ApiError::Conflict(_)));
    }
}
