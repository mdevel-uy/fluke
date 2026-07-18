//! Routes for the local `gh` CLI-based GitHub authentication flow.
//!
//! These endpoints wrap the `gh` binary already used elsewhere in the
//! backend (see `crates/git-host/src/github/cli.rs`). They expose two
//! operations to the web client:
//!
//! - `GET  /api/github/status` — reports whether the user is authenticated
//!   with `gh` and the state of any in-flight login attempt.
//! - `POST /api/github/login` — starts (or resumes) a `gh auth login` web
//!   flow, captures the one-time code plus verification URL from `gh`'s
//!   output, and returns them to the client for display. Progress can be
//!   polled from the status endpoint.

use std::{
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, oneshot},
    time::timeout,
};
use ts_rs::TS;
use utils::{command_ext::NoWindowExt, response::ApiResponse, shell::resolve_executable_path};

use crate::{DeploymentImpl, error::ApiError};

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

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/github/status", get(get_status))
        .route("/github/login", post(post_login))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
