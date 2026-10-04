//! Routes for the local GitHub integration.
//!
//! Authentication uses GitHub's OAuth device flow directly against
//! github.com — no console interaction with `gh` is required. On success the
//! token is persisted to the app config and, when the `gh` CLI is available,
//! handed to it via `gh auth login --with-token` so every `gh`-backed
//! feature (PRs, issues, reviews) keeps working unchanged.
//!
//! Authentication flow:
//! - `GET  /api/github/status` — reports whether the user is authenticated
//!   and the state of any in-flight login attempt. Includes `has_pat` and
//!   `auth_method` so the UI can distinguish PAT-backed sessions from the
//!   `gh` CLI flow.
//! - `POST /api/github/login` — starts (or resumes) a device flow login and
//!   returns the one-time code plus verification URL for display. Progress
//!   can be polled from the status endpoint.
//! - `POST /api/github/login/pat` — alternative login for hosts without
//!   `gh`: validates a Personal Access Token against `/user` and stores it
//!   in the app config. The token is never returned by any endpoint.
//! - `DELETE /api/github/pat` — clears the stored PAT while leaving the
//!   device-flow oauth token untouched.
//! - `POST /api/github/logout` — clears stored device-flow credentials and
//!   logs the `gh` CLI out of github.com.
//!
//! Repository management:
//! - `GET  /api/github/repos` — lists the authenticated user's repos plus
//!   repos from every org they belong to.
//! - `POST /api/github/clone` — clones `<owner>/<repo>` into the local
//!   repos directory, ready to be used as a project path.
//! - `GET  /api/github/owners` — accounts the session can create repos
//!   under: the user first, then their organizations. Creating the repo
//!   for a local one is `POST /api/repos/{repo_id}/github` (routes/repo.rs).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    extract::State,
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::{
    config::save_config_to_file,
    repo::{
        GithubCreateError, GithubRepoCreator, GithubRepoInfo, RepoError as RepoServiceError,
        RepoVisibility,
    },
};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex, task};
use ts_rs::TS;
use utils::{
    assets::{asset_dir, config_path},
    command_ext::NoWindowExt,
    response::ApiResponse,
    shell::{managed_bin_dir, resolve_executable_path, resolve_executable_path_blocking},
};

use crate::{DeploymentImpl, error::ApiError};

// ============================================================================
// Router
// ============================================================================

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/github/status", get(get_status))
        .route("/github/login", post(post_login))
        .route("/github/login/pat", post(post_login_pat))
        .route("/github/pat", delete(delete_pat))
        .route("/github/logout", post(post_logout))
        .route("/github/cli/install", post(install_gh_cli))
        .route("/github/repos", get(list_github_repos))
        .route("/github/clone", post(clone_github_repo))
        .route("/github/owners", get(list_github_owners))
}

// ============================================================================
// Authentication flow (status / login)
// ============================================================================

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";

/// Public OAuth client ID of the official GitHub CLI application (published
/// in <https://github.com/cli/cli>). Device flow tokens minted with it are
/// the same kind `gh auth login` produces, so they can be handed straight
/// back to `gh` via `--with-token`. Override with `GITHUB_APP_CLIENT_ID`.
const DEFAULT_OAUTH_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";
const OAUTH_SCOPES: &str = "repo,read:org,gist,workflow";

fn oauth_client_id() -> String {
    std::env::var("GITHUB_APP_CLIENT_ID")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("fluke-server")
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {e}"))
}

/// State of the in-progress device flow login.
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

/// How the user is currently authenticated with GitHub.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GithubAuthMethod {
    /// Authenticated via a Personal Access Token stored in the app config.
    Pat,
    /// Authenticated via the local `gh` CLI (device flow or `gh auth login`).
    GhCli,
}

/// Response body for `GET /api/github/status`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GithubStatusResponse {
    pub authenticated: bool,
    pub username: Option<String>,
    /// Whether the `gh` binary was found on PATH. Login works without it,
    /// but PRs, issue sync and reviews still require it.
    pub cli_available: bool,
    /// Whether a Personal Access Token is stored in the app config. The
    /// token value itself is never returned.
    pub has_pat: bool,
    /// Which credential the current authenticated session is using, or
    /// `None` if the user is not authenticated.
    pub auth_method: Option<GithubAuthMethod>,
    pub login: Option<GithubLoginProgress>,
}

/// Response body for `POST /api/github/login`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GithubLoginResponse {
    pub user_code: String,
    pub verification_uri: String,
}

/// Body for `POST /api/github/login/pat`.
#[derive(Debug, Deserialize, TS)]
pub struct GithubPatLoginRequest {
    pub pat: String,
}

/// Response body for `POST /api/github/login/pat`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GithubPatLoginResponse {
    pub username: String,
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

async fn get_status(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<GithubStatusResponse>>, ApiError> {
    let cli_available = resolve_executable_path("gh").await.is_some();
    let github = deployment.config().read().await.github.clone();
    let has_pat = github.pat.as_deref().is_some_and(|s| !s.trim().is_empty());

    let mut authenticated = false;
    let mut username: Option<String> = None;
    let mut auth_method: Option<GithubAuthMethod> = None;

    // PAT takes precedence when configured: the user explicitly set it in
    // the UI, so we honour it even if `gh` is also authenticated with a
    // different identity. Revocation/expiry is detected here by probing
    // /user; on 401/403 we report unauthenticated so the UI can prompt the
    // user to reconnect.
    if let Some(pat) = github.pat.as_deref() {
        match fetch_username(pat).await {
            Some(name) => {
                authenticated = true;
                username = Some(name);
                auth_method = Some(GithubAuthMethod::Pat);
            }
            None => {
                tracing::warn!(
                    "stored GitHub PAT was rejected by /user; reporting unauthenticated"
                );
            }
        }
    }

    if !authenticated && cli_available {
        let (gh_auth, gh_user) = gh_auth_status().await;
        if gh_auth {
            authenticated = true;
            username = gh_user;
            auth_method = Some(GithubAuthMethod::GhCli);
        }
    }

    // Fall back to the token stored by the device flow (covers hosts where
    // `gh` is not installed or not yet configured).
    if !authenticated
        && let Some(token) = github.oauth_token.as_deref()
        && let Some(name) = fetch_username(token).await
    {
        authenticated = true;
        username = Some(name);
        auth_method = Some(GithubAuthMethod::GhCli);
    }

    let login = flow_state().lock().await.progress.clone();
    Ok(ResponseJson(ApiResponse::success(GithubStatusResponse {
        authenticated,
        username,
        cli_available,
        has_pat,
        auth_method,
        login,
    })))
}

async fn post_login(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<GithubLoginResponse>>, ApiError> {
    let state = flow_state();
    {
        let mut g = state.lock().await;
        if g.running {
            // If a login is already in progress, return the cached code/URL
            // so the client can display them.
            if let Some(prog) = &g.progress
                && let (Some(code), Some(uri)) = (&prog.user_code, &prog.verification_uri)
            {
                return Ok(ResponseJson(ApiResponse::success(GithubLoginResponse {
                    user_code: code.clone(),
                    verification_uri: uri.clone(),
                })));
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

    let device = match request_device_code().await {
        Ok(d) => d,
        Err(msg) => {
            finalize_failure(&state, &msg).await;
            return Err(ApiError::BadGateway(msg));
        }
    };

    {
        let mut g = state.lock().await;
        if let Some(p) = g.progress.as_mut() {
            p.user_code = Some(device.user_code.clone());
            p.verification_uri = Some(device.verification_uri.clone());
        }
    }

    let response = GithubLoginResponse {
        user_code: device.user_code.clone(),
        verification_uri: device.verification_uri.clone(),
    };

    let poll_state = state.clone();
    tokio::spawn(async move {
        poll_for_token(poll_state, deployment, device).await;
    });

    Ok(ResponseJson(ApiResponse::success(response)))
}

async fn post_logout(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    {
        let state = flow_state();
        let mut g = state.lock().await;
        if !g.running {
            g.progress = None;
        }
    }

    if let Some(gh) = resolve_executable_path("gh").await {
        let out = Command::new(&gh)
            .args(["auth", "logout", "--hostname", "github.com"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .output()
            .await;
        match out {
            Ok(o) if !o.status.success() => tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "`gh auth logout` exited unsuccessfully"
            ),
            Err(e) => tracing::warn!(?e, "failed to run `gh auth logout`"),
            _ => {}
        }
    }

    persist_github_config(&deployment, GithubConfigUpdate::clear_oauth())
        .await
        .map_err(|e| ApiError::BadGateway(format!("Failed to update config: {e}")))?;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Validates a Personal Access Token against the GitHub API and, on
/// success, persists it to `config.github.pat`. The token value is never
/// echoed back — only the resolved username is returned.
async fn post_login_pat(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<GithubPatLoginRequest>,
) -> Result<ResponseJson<ApiResponse<GithubPatLoginResponse>>, ApiError> {
    let pat = payload.pat.trim().to_string();
    if pat.is_empty() {
        return Err(ApiError::BadRequest("pat is required".to_string()));
    }

    let username = match validate_pat(&pat).await {
        Ok(name) => name,
        Err(msg) => return Err(ApiError::BadRequest(msg)),
    };

    persist_github_config(
        &deployment,
        GithubConfigUpdate::set_pat(pat.clone(), Some(username.clone())),
    )
    .await
    .map_err(|e| ApiError::BadGateway(format!("Failed to update config: {e}")))?;

    Ok(ResponseJson(ApiResponse::success(GithubPatLoginResponse {
        username,
    })))
}

/// Clears any stored PAT from `config.github.pat`. Leaves the device-flow
/// `oauth_token` untouched so users who authenticated via both methods keep
/// their gh-CLI session.
async fn delete_pat(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    persist_github_config(&deployment, GithubConfigUpdate::clear_pat())
        .await
        .map_err(|e| ApiError::BadGateway(format!("Failed to update config: {e}")))?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Validates a candidate PAT by calling `GET /user`. Returns the login on
/// success, a descriptive error message on failure (401/403 → invalid or
/// missing scopes; network errors → underlying reason).
async fn validate_pat(pat: &str) -> Result<String, String> {
    let client = http_client()?;
    let resp = client
        .get(GITHUB_USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(pat)
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Token inválido o sin los scopes necesarios (repo, read:org, workflow).".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("GitHub /user returned status {status}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub /user response: {e}"))?;
    body.get("login")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "GitHub /user response did not include a login".to_string())
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn request_device_code() -> Result<DeviceCodeResponse, String> {
    let client = http_client()?;
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": oauth_client_id(),
            "scope": OAUTH_SCOPES,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub device code request failed with status {}",
            resp.status()
        ));
    }

    resp.json::<DeviceCodeResponse>()
        .await
        .map_err(|e| format!("Failed to parse GitHub device code response: {e}"))
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

/// Polls GitHub for the access token until the user authorizes the device
/// code (or it expires), then persists the credential and configures `gh`.
async fn poll_for_token(
    state: Arc<Mutex<LoginFlowState>>,
    deployment: DeploymentImpl,
    device: DeviceCodeResponse,
) {
    let client = match http_client() {
        Ok(c) => c,
        Err(msg) => {
            finalize_failure(&state, &msg).await;
            return;
        }
    };

    let mut interval = device.interval.unwrap_or(5).max(1);
    let expires_in = device.expires_in.unwrap_or(900);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires_in);

    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if tokio::time::Instant::now() >= deadline {
            finalize_failure(
                &state,
                "The device code expired before the login was authorized. Start the login again.",
            )
            .await;
            return;
        }

        let resp = client
            .post(ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "client_id": oauth_client_id(),
                "device_code": device.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }))
            .send()
            .await;

        let parsed: AccessTokenResponse = match resp {
            Ok(r) => match r.json().await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(?e, "failed to parse GitHub token response; retrying");
                    continue;
                }
            },
            Err(e) => {
                tracing::warn!(?e, "GitHub token poll request failed; retrying");
                continue;
            }
        };

        if let Some(token) = parsed.access_token {
            complete_login(&state, &deployment, &token).await;
            return;
        }

        match parsed.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval = parsed.interval.unwrap_or(interval + 5);
            }
            Some("expired_token") => {
                finalize_failure(
                    &state,
                    "The device code expired before the login was authorized. Start the login again.",
                )
                .await;
                return;
            }
            Some("access_denied") => {
                finalize_failure(&state, "The login request was cancelled on GitHub.").await;
                return;
            }
            Some(other) => {
                let msg = parsed
                    .error_description
                    .unwrap_or_else(|| format!("GitHub returned an error during login: {other}"));
                finalize_failure(&state, &msg).await;
                return;
            }
            None => {
                tracing::warn!("GitHub token response had neither a token nor an error; retrying");
            }
        }
    }
}

async fn complete_login(
    state: &Arc<Mutex<LoginFlowState>>,
    deployment: &DeploymentImpl,
    token: &str,
) {
    let username = fetch_username(token).await;

    if let Err(e) = persist_github_config(
        deployment,
        GithubConfigUpdate::set_oauth(Some(token.to_string()), username),
    )
    .await
    {
        tracing::warn!(%e, "failed to persist GitHub credentials to config");
    }

    if let Some(gh) = resolve_executable_path("gh").await {
        configure_gh_cli(&gh, token).await;
    }

    let mut g = state.lock().await;
    g.running = false;
    if let Some(p) = g.progress.as_mut() {
        p.state = GithubLoginState::Completed;
        p.error = None;
    }
}

async fn fetch_username(token: &str) -> Option<String> {
    let client = http_client().ok()?;
    let resp = client
        .get(GITHUB_USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("login")?.as_str().map(|s| s.to_string())
}

/// Selective update of `config.github`. Fields left as `None` are not
/// touched; wrapping the value in `Some(...)` (including `Some(None)`
/// through the constructors below) explicitly overwrites the stored value.
#[derive(Debug)]
struct GithubConfigUpdate {
    pat: Option<Option<String>>,
    oauth_token: Option<Option<String>>,
    username: Option<Option<String>>,
}

impl GithubConfigUpdate {
    /// Store a validated PAT and its resolved username. Leaves the
    /// device-flow oauth token untouched so users authenticated via both
    /// methods keep both credentials.
    fn set_pat(pat: String, username: Option<String>) -> Self {
        Self {
            pat: Some(Some(pat)),
            oauth_token: None,
            username: Some(username),
        }
    }

    fn clear_pat() -> Self {
        Self {
            pat: Some(None),
            oauth_token: None,
            // Clear the cached username too so the UI reverts to whatever
            // `gh` (if any) reports.
            username: Some(None),
        }
    }

    fn set_oauth(oauth_token: Option<String>, username: Option<String>) -> Self {
        Self {
            pat: None,
            oauth_token: Some(oauth_token),
            username: Some(username),
        }
    }

    fn clear_oauth() -> Self {
        Self {
            pat: None,
            oauth_token: Some(None),
            username: Some(None),
        }
    }
}

async fn persist_github_config(
    deployment: &DeploymentImpl,
    update: GithubConfigUpdate,
) -> Result<(), String> {
    let snapshot = {
        let mut config = deployment.config().write().await;
        if let Some(pat) = update.pat {
            config.github.pat = pat;
        }
        if let Some(oauth_token) = update.oauth_token {
            config.github.oauth_token = oauth_token;
        }
        if let Some(username) = update.username {
            config.github.username = username;
        }
        config.clone()
    };
    save_config_to_file(&snapshot, &config_path())
        .await
        .map_err(|e| e.to_string())
}

/// Hands the device flow token to the `gh` CLI so every `gh`-backed feature
/// works with it, then wires up git credential helpers.
async fn configure_gh_cli(gh: &Path, token: &str) {
    let mut cmd = Command::new(gh);
    cmd.args([
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--with-token",
    ]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.no_window();

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(?e, "failed to spawn `gh auth login --with-token`");
            return;
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(token.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.shutdown().await;
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            let setup = Command::new(gh)
                .args(["auth", "setup-git"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .no_window()
                .output()
                .await;
            match setup {
                Ok(o) if !o.status.success() => tracing::warn!(
                    stderr = %String::from_utf8_lossy(&o.stderr),
                    "`gh auth setup-git` exited unsuccessfully"
                ),
                Err(e) => tracing::warn!(?e, "`gh auth setup-git` failed after login"),
                _ => {}
            }
        }
        Ok(out) => tracing::warn!(
            stderr = %String::from_utf8_lossy(&out.stderr),
            "`gh auth login --with-token` exited unsuccessfully"
        ),
        Err(e) => tracing::warn!(?e, "failed to wait for `gh auth login --with-token`"),
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

// ============================================================================
// gh CLI installation
// ============================================================================

/// Response body for `POST /api/github/cli/install`.
#[derive(Debug, Serialize, TS)]
pub struct GithubCliInstallResponse {
    pub version: Option<String>,
    pub path: String,
}

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Downloads the official `gh` release binary into the app-managed bin
/// directory. No package manager or elevated permissions required; the
/// managed dir is a final fallback in `resolve_executable_path`, so a later
/// system-wide install takes precedence automatically.
async fn install_gh_cli() -> Result<ResponseJson<ApiResponse<GithubCliInstallResponse>>, ApiError> {
    let _guard = INSTALL_LOCK.get_or_init(|| Mutex::new(())).lock().await;

    if let Some(existing) = resolve_executable_path("gh").await {
        return Ok(ResponseJson(ApiResponse::success(
            GithubCliInstallResponse {
                version: gh_version(&existing).await,
                path: existing.display().to_string(),
            },
        )));
    }

    let installed = download_gh_cli().await.map_err(ApiError::BadGateway)?;
    let version = gh_version(&installed).await;
    Ok(ResponseJson(ApiResponse::success(
        GithubCliInstallResponse {
            version,
            path: installed.display().to_string(),
        },
    )))
}

async fn gh_version(gh: &Path) -> Option<String> {
    let out = Command::new(gh)
        .arg("--version")
        .stdin(Stdio::null())
        .no_window()
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // First line looks like "gh version 2.63.0 (2024-11-27)".
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(2))
        .map(|v| v.to_string())
}

async fn download_gh_cli() -> Result<PathBuf, String> {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => return Err(format!("Unsupported CPU architecture: {other}")),
    };
    let ext = if cfg!(target_os = "linux") {
        "tar.gz"
    } else {
        "zip"
    };

    let client = http_client()?;
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/cli/cli/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub release info: {e}"))?;
    let tag = release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "GitHub release info had no tag_name".to_string())?
        .to_string();
    let version = tag.trim_start_matches('v');

    let asset = format!("gh_{version}_{os}_{arch}.{ext}");
    let url = format!("https://github.com/cli/cli/releases/download/{tag}/{asset}");

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {asset}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download of {asset} failed with status {}",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to download {asset}: {e}"))?;

    task::spawn_blocking(move || extract_gh_archive(&asset, &bytes))
        .await
        .map_err(|e| format!("Install task join failed: {e}"))?
}

/// Writes the downloaded archive to a staging dir, extracts it with the
/// platform `tar` (bsdtar on Windows/macOS also handles zip), and moves the
/// `gh` binary into the managed bin dir.
fn extract_gh_archive(asset: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let staging = asset_dir().join("tmp").join("gh-install");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Failed to create staging dir: {e}"))?;

    let archive_path = staging.join(asset);
    std::fs::write(&archive_path, bytes).map_err(|e| format!("Failed to write archive: {e}"))?;

    let extract_dir = staging.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Failed to create dir: {e}"))?;

    let tar = resolve_executable_path_blocking("tar")
        .ok_or_else(|| "`tar` was not found on this system".to_string())?;
    let out = std::process::Command::new(&tar)
        .arg("-xf")
        .arg(&archive_path)
        .arg("-C")
        .arg(&extract_dir)
        .no_window()
        .output()
        .map_err(|e| format!("Failed to run tar: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "tar failed to extract {asset}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let binary_name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let extracted = find_file(&extract_dir, binary_name, 3)
        .ok_or_else(|| format!("{binary_name} not found inside {asset}"))?;

    let dest_dir = managed_bin_dir();
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("Failed to create bin dir: {e}"))?;
    let dest = dest_dir.join(binary_name);
    std::fs::copy(&extracted, &dest).map_err(|e| format!("Failed to install gh: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to mark gh executable: {e}"))?;
    }

    let _ = std::fs::remove_dir_all(&staging);
    Ok(dest)
}

fn find_file(dir: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().is_some_and(|f| f == name) {
            return Some(path);
        }
        if path.is_dir() {
            subdirs.push(path);
        }
    }
    if max_depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|d| find_file(&d, name, max_depth - 1))
}

async fn gh_auth_status() -> (bool, Option<String>) {
    let Some(gh) = resolve_executable_path("gh").await else {
        return (false, None);
    };

    let output = Command::new(&gh)
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

async fn list_github_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<GitHubRepoSummary>>>, ApiError> {
    let pat = configured_pat(&deployment).await;
    let repos = task::spawn_blocking(move || collect_all_repos_blocking(pat.as_deref()))
        .await
        .map_err(|e| ApiError::BadGateway(format!("gh task join failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

fn collect_all_repos_blocking(pat: Option<&str>) -> Result<Vec<GitHubRepoSummary>, ApiError> {
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
        pat,
    )?;
    let user_repos: Vec<GhRepoListItem> = serde_json::from_str(user_raw.trim())
        .map_err(|e| ApiError::BadGateway(format!("Failed to parse `gh repo list` output: {e}")))?;

    let orgs_raw = run_gh_blocking(
        &["api", "user/orgs", "--paginate", "--jq", ".[].login"],
        None,
        pat,
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
            pat,
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

/// Reads the currently configured PAT (if any) from the app config so it
/// can be injected as `GH_TOKEN` when calling out to `gh`. Trimmed and
/// filtered so an empty string is treated the same as "no token".
pub(crate) async fn configured_pat(deployment: &DeploymentImpl) -> Option<String> {
    deployment
        .config()
        .read()
        .await
        .github
        .pat
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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
    State(deployment): State<DeploymentImpl>,
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
    let pat = configured_pat(&deployment).await;
    let cloned_path = task::spawn_blocking(move || -> Result<PathBuf, ApiError> {
        let target_str = target_for_task.to_string_lossy().to_string();
        run_gh_blocking(
            &["repo", "clone", &name_with_owner, &target_str],
            None,
            pat.as_deref(),
        )?;
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

fn run_gh_blocking(
    args: &[&str],
    dir: Option<&Path>,
    token: Option<&str>,
) -> Result<String, ApiError> {
    let gh = resolve_executable_path_blocking("gh").ok_or_else(|| {
        ApiError::BadRequest(
            "GitHub CLI (`gh`) not found in PATH. Install it and run `gh auth login`.".to_string(),
        )
    })?;

    let mut cmd = std::process::Command::new(&gh);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
        // GH_TOKEN wins over any stored `gh auth` credentials, so a
        // UI-configured PAT is used consistently even when a stale keyring
        // entry exists.
        cmd.env("GH_TOKEN", t);
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
// Repository creation (owners + `gh api` backed creator)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum GithubOwnerKind {
    User,
    Organization,
}

/// An account the current session can create repositories under.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GithubOwner {
    pub login: String,
    pub kind: GithubOwnerKind,
}

async fn list_github_owners(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<GithubOwner>>>, ApiError> {
    let creator = GhRepoCreator::new(configured_pat(&deployment).await);
    let owners = task::spawn_blocking(move || creator.owners())
        .await
        .map_err(|e| ApiError::BadGateway(format!("gh task join failed: {e}")))?
        .map_err(gh_create_error_to_api)?;
    Ok(ResponseJson(ApiResponse::success(owners)))
}

fn gh_create_error_to_api(err: GithubCreateError) -> ApiError {
    ApiError::from(match err {
        GithubCreateError::NoSession => RepoServiceError::GithubSessionRequired,
        GithubCreateError::NameTaken => {
            RepoServiceError::GithubRequestFailed("name already exists".to_string())
        }
        GithubCreateError::PermissionDenied(msg) | GithubCreateError::Other(msg) => {
            RepoServiceError::GithubRequestFailed(msg)
        }
    })
}

/// The user first, then their organizations; blank lines and duplicates
/// (logins are case-insensitive) dropped.
fn parse_github_owners(user_login: &str, orgs_raw: &str) -> Vec<GithubOwner> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut owners = Vec::new();
    let user = user_login.trim();
    if !user.is_empty() && seen.insert(user.to_ascii_lowercase()) {
        owners.push(GithubOwner {
            login: user.to_string(),
            kind: GithubOwnerKind::User,
        });
    }
    for org in orgs_raw.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if seen.insert(org.to_ascii_lowercase()) {
            owners.push(GithubOwner {
                login: org.to_string(),
                kind: GithubOwnerKind::Organization,
            });
        }
    }
    owners
}

/// Classifies a failed `gh api` call made while creating a repository.
fn classify_gh_repo_create_failure(exit_code: Option<i32>, stderr: &str) -> GithubCreateError {
    let lower = stderr.to_ascii_lowercase();

    if exit_code == Some(4)
        || lower.contains("gh auth login")
        || lower.contains("must authenticate")
        || lower.contains("authentication failed")
        || lower.contains("bad credentials")
        || lower.contains("http 401")
    {
        return GithubCreateError::NoSession;
    }

    if lower.contains("name already exists") {
        return GithubCreateError::NameTaken;
    }

    if lower.contains("does not have the correct permissions")
        || lower.contains("resource not accessible")
        || lower.contains("http 403")
        || lower.contains("forbidden")
    {
        return GithubCreateError::PermissionDenied(stderr.to_string());
    }

    GithubCreateError::Other(if stderr.is_empty() {
        format!("gh exited with code {exit_code:?}")
    } else {
        stderr.to_string()
    })
}

#[derive(Debug, Deserialize)]
struct GhApiRepoOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhApiRepo {
    name: String,
    html_url: String,
    clone_url: String,
    owner: GhApiRepoOwner,
}

/// [`GithubRepoCreator`] backed by `gh api`, authenticated like the rest of
/// this module (the configured PAT as `GH_TOKEN`, else `gh`'s own login).
pub struct GhRepoCreator {
    pat: Option<String>,
    user_login: OnceLock<String>,
}

impl GhRepoCreator {
    pub fn new(pat: Option<String>) -> Self {
        Self {
            pat,
            user_login: OnceLock::new(),
        }
    }

    fn gh(&self, args: &[&str]) -> Result<String, GithubCreateError> {
        let gh = resolve_executable_path_blocking("gh").ok_or_else(|| {
            GithubCreateError::Other(
                "GitHub CLI (`gh`) not found. Install it from Settings → GitHub and sign in."
                    .to_string(),
            )
        })?;
        let mut cmd = std::process::Command::new(&gh);
        if let Some(t) = self.pat.as_deref().filter(|t| !t.trim().is_empty()) {
            cmd.env("GH_TOKEN", t);
        }
        cmd.args(args);
        let output = cmd
            .no_window()
            .output()
            .map_err(|e| GithubCreateError::Other(format!("Failed to spawn gh: {e}")))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }
        // `gh api` prints a short error on stderr and the response body
        // (with GitHub's detailed `errors[].message`) on stdout.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stdout.is_empty() {
            stderr
        } else {
            format!("{stderr}\n{stdout}")
        };
        Err(classify_gh_repo_create_failure(
            output.status.code(),
            &detail,
        ))
    }

    fn user_login(&self) -> Result<String, GithubCreateError> {
        if let Some(login) = self.user_login.get() {
            return Ok(login.clone());
        }
        let login = self.gh(&["api", "user", "--jq", ".login"])?.trim().to_string();
        if login.is_empty() {
            return Err(GithubCreateError::NoSession);
        }
        Ok(self.user_login.get_or_init(|| login).clone())
    }

    pub fn owners(&self) -> Result<Vec<GithubOwner>, GithubCreateError> {
        let login = self.user_login()?;
        let orgs = self.gh(&["api", "user/orgs", "--paginate", "--jq", ".[].login"])?;
        Ok(parse_github_owners(&login, &orgs))
    }

    fn parse_repo(raw: &str) -> Result<GhApiRepo, GithubCreateError> {
        serde_json::from_str(raw.trim()).map_err(|e| {
            GithubCreateError::Other(format!("Failed to parse GitHub repository response: {e}"))
        })
    }
}

impl GithubRepoCreator for GhRepoCreator {
    fn list_owners(&self) -> Result<Vec<String>, GithubCreateError> {
        Ok(self.owners()?.into_iter().map(|o| o.login).collect())
    }

    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: RepoVisibility,
    ) -> Result<GithubRepoInfo, GithubCreateError> {
        let endpoint = if owner.eq_ignore_ascii_case(&self.user_login()?) {
            "user/repos".to_string()
        } else {
            format!("orgs/{owner}/repos")
        };
        let name_field = format!("name={name}");
        let private_field = format!(
            "private={}",
            matches!(visibility, RepoVisibility::Private)
        );
        let raw = self.gh(&[
            "api",
            "-X",
            "POST",
            &endpoint,
            "-f",
            &name_field,
            "-F",
            &private_field,
        ])?;
        let repo = Self::parse_repo(&raw)?;
        Ok(GithubRepoInfo {
            owner: repo.owner.login,
            name: repo.name,
            html_url: repo.html_url,
            clone_url: repo.clone_url,
            is_empty: true,
        })
    }

    fn find_repo(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<Option<GithubRepoInfo>, GithubCreateError> {
        let path = format!("repos/{owner}/{name}");
        let raw = match self.gh(&["api", &path]) {
            Ok(raw) => raw,
            Err(GithubCreateError::Other(msg))
                if msg.contains("404") || msg.to_ascii_lowercase().contains("not found") =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let repo = Self::parse_repo(&raw)?;
        // A repository without branches has never been pushed to.
        let branches_path = format!("repos/{owner}/{name}/branches");
        let is_empty = match self.gh(&["api", &branches_path, "--jq", "length"]) {
            Ok(count) => count.trim() == "0",
            // GitHub answers 409 "Git Repository is empty" for some endpoints.
            Err(GithubCreateError::Other(msg)) if msg.contains("409") => true,
            Err(e) => return Err(e),
        };
        Ok(Some(GithubRepoInfo {
            owner: repo.owner.login,
            name: repo.name,
            html_url: repo.html_url,
            clone_url: repo.clone_url,
            is_empty,
        }))
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- auth parsing ----------

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

// ============================================================================
// Tests: crear repo en GitHub (issue #774)
//
// Contrato esperado en este módulo:
// - `classify_gh_repo_create_failure(exit_code, stderr) -> GithubCreateError`
//   (de `services::services::repo`), para `gh repo create` / `gh api`.
// - `parse_github_owners(user_login, orgs_raw) -> Vec<GithubOwner>` con
//   `GithubOwner { login: String, kind: GithubOwnerKind }`,
//   `GithubOwnerKind::{User, Organization}` serializado en minúsculas
//   (`"user"` / `"organization"`): primero el usuario, luego las orgs.
// ============================================================================

#[cfg(test)]
mod create_repo_tests {
    use services::services::repo::GithubCreateError;

    use super::*;

    #[test]
    fn create_failure_without_session_is_no_session() {
        let by_exit = classify_gh_repo_create_failure(Some(4), "");
        assert!(matches!(by_exit, GithubCreateError::NoSession), "{by_exit:?}");

        let by_text = classify_gh_repo_create_failure(
            Some(1),
            "To get started with GitHub CLI, please run:  gh auth login",
        );
        assert!(matches!(by_text, GithubCreateError::NoSession), "{by_text:?}");

        let bad_token = classify_gh_repo_create_failure(Some(1), "HTTP 401: Bad credentials");
        assert!(matches!(bad_token, GithubCreateError::NoSession), "{bad_token:?}");
    }

    #[test]
    fn create_failure_name_already_exists_is_name_taken() {
        let err = classify_gh_repo_create_failure(
            Some(1),
            "GraphQL: Name already exists on this account (createRepository)",
        );
        assert!(matches!(err, GithubCreateError::NameTaken), "{err:?}");

        let rest = classify_gh_repo_create_failure(
            Some(1),
            "HTTP 422: Repository creation failed.: name already exists on this account",
        );
        assert!(matches!(rest, GithubCreateError::NameTaken), "{rest:?}");
    }

    #[test]
    fn create_failure_org_permissions_is_permission_denied() {
        let graphql = classify_gh_repo_create_failure(
            Some(1),
            "GraphQL: acme does not have the correct permissions to execute `CreateRepository`",
        );
        assert!(
            matches!(graphql, GithubCreateError::PermissionDenied(_)),
            "{graphql:?}"
        );

        let rest = classify_gh_repo_create_failure(
            Some(1),
            "HTTP 403: Resource not accessible by personal access token",
        );
        assert!(
            matches!(rest, GithubCreateError::PermissionDenied(_)),
            "{rest:?}"
        );
    }

    #[test]
    fn create_failure_unknown_keeps_stderr_for_the_user() {
        let err = classify_gh_repo_create_failure(Some(1), "something unexpected exploded");
        match err {
            GithubCreateError::Other(msg) => {
                assert!(msg.contains("something unexpected exploded"))
            }
            other => panic!("se esperaba Other, llegó {other:?}"),
        }
    }

    #[test]
    fn owners_list_has_user_first_then_organizations() {
        let owners = parse_github_owners("octocat", "acme\nglobex\n");

        let logins: Vec<&str> = owners.iter().map(|o| o.login.as_str()).collect();
        assert_eq!(logins, vec!["octocat", "acme", "globex"]);
        assert!(matches!(owners[0].kind, GithubOwnerKind::User));
        assert!(matches!(owners[1].kind, GithubOwnerKind::Organization));
        assert!(matches!(owners[2].kind, GithubOwnerKind::Organization));
    }

    #[test]
    fn owners_list_ignores_blank_lines_and_duplicates() {
        let owners = parse_github_owners("octocat", "\n acme \n\nacme\noctocat\n");

        let logins: Vec<&str> = owners.iter().map(|o| o.login.as_str()).collect();
        assert_eq!(logins, vec!["octocat", "acme"]);
    }

    #[test]
    fn owners_list_without_orgs_is_just_the_user() {
        let owners = parse_github_owners("octocat", "");

        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].login, "octocat");
    }

    #[test]
    fn owner_kind_serializes_lowercase_for_the_ui() {
        let json = serde_json::to_value(GithubOwner {
            login: "acme".into(),
            kind: GithubOwnerKind::Organization,
        })
        .unwrap();

        assert_eq!(json["login"], "acme");
        assert_eq!(json["kind"], "organization");
    }
}
