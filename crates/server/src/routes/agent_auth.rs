//! Connect / disconnect the Codex and Gemini CLIs from Settings, no console
//! required.
//!
//! Modeled on the GitHub device-flow endpoints in [`crate::routes::github`]:
//! the login runs in the background and the frontend polls status until the
//! provider reports itself connected (i.e. the CLI has written its auth
//! artifact into `$HOME`).
//!
//! Each provider carries its own login mechanic:
//!
//! - **Codex** — spawns `codex login --device-auth` and parses the URL + code
//!   the CLI prints so the UI can show them. Success is detected by the
//!   appearance of `~/.codex/auth.json`.
//! - **Gemini** — the CLI has no non-interactive OAuth entry point, so we
//!   fall back to an API-key flow (same shape as GitHub PAT): the user
//!   supplies a `GEMINI_API_KEY`, we validate the shape and persist it as
//!   `~/.gemini/.env`, which the CLI picks up on startup.
//! - **Claude Code** — spawns `claude setup-token` inside a PTY (the CLI
//!   refuses to render its OAuth prompt on a bare pipe) and streams the
//!   authorize URL out for the UI. The flow needs a second step: after
//!   completing the browser handoff the user pastes the exchange code back,
//!   which we forward to the CLI's stdin via
//!   `POST /agents/auth/claude_code/login/submit`. `setup-token` then prints
//!   a long-lived token instead of writing `~/.claude/.credentials.json`; we
//!   capture it into `~/.claude/fluke-oauth-token` and the Claude executor
//!   exports it as `CLAUDE_CODE_OAUTH_TOKEN` (see
//!   `executors::executors::claude::stored_claude_oauth_token`).
//!
//! Providers whose CLI is not installed on the image are still reported so
//! the UI can hide their card; the check reuses the same executable
//! resolution the executors use to spawn the CLI.

use std::{
    collections::HashMap,
    io::{Read as _, Write as _},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use executors::executors::{BaseCodingAgent, claude::claude_oauth_token_path};
use local_deployment::portable_pty::{
    self, CommandBuilder, NativePtySystem, PtySize, PtySystem,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    task::JoinHandle,
    time::sleep,
};
use ts_rs::TS;
use utils::{
    command_ext::NoWindowExt, response::ApiResponse, shell::resolve_executable_path,
};

use crate::{DeploymentImpl, error::ApiError};

// ============================================================================
// Types (TS-exported)
// ============================================================================

/// One of the coding-agent CLIs whose OAuth/API-key state Settings manages.
///
/// Kept as a small closed set instead of reusing `BaseCodingAgent` because
/// only the CLIs that have a working "connect from Settings" story appear
/// here — other agents (Cursor, Amp, Copilot, ...) run through the
/// workspace-scoped setup helper.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentAuthProvider {
    Codex,
    Gemini,
    ClaudeCode,
}

impl AgentAuthProvider {
    fn as_slug(self) -> &'static str {
        match self {
            AgentAuthProvider::Codex => "codex",
            AgentAuthProvider::Gemini => "gemini",
            AgentAuthProvider::ClaudeCode => "claude_code",
        }
    }

    fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            "codex" => Some(AgentAuthProvider::Codex),
            "gemini" => Some(AgentAuthProvider::Gemini),
            "claude_code" => Some(AgentAuthProvider::ClaudeCode),
            _ => None,
        }
    }
}

/// State of the most recent (or in-flight) login attempt for a provider.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentLoginState {
    /// A login command is running or waiting for the user to complete the
    /// browser flow.
    Pending,
    /// The login finished successfully; the auth artifact is on disk.
    Completed,
    /// The login attempt failed (CLI exit non-zero, or user cancelled).
    Failed,
}

/// Progress payload for a provider's login attempt. All fields except
/// `state` are best-effort; e.g. `user_code`/`verification_uri` are only
/// filled once the CLI prints them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentLoginProgress {
    pub state: AgentLoginState,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub error: Option<String>,
}

/// Per-provider snapshot used by the Settings page.
#[derive(Debug, Clone, Serialize, TS)]
pub struct AgentAuthProviderStatus {
    pub provider: AgentAuthProvider,
    /// Whether the CLI binary was found on PATH. When `false`, Settings hides
    /// the card entirely — nothing to connect to.
    pub cli_available: bool,
    /// Whether an auth artifact for this provider exists (e.g.
    /// `~/.codex/auth.json` or a stored `GEMINI_API_KEY`).
    pub connected: bool,
    /// Epoch seconds of the last modification to the auth artifact, when
    /// available.
    pub last_auth_at: Option<i64>,
    pub login: Option<AgentLoginProgress>,
}

/// `GET /api/agents/auth` — status for every provider Settings knows about.
#[derive(Debug, Serialize, TS)]
pub struct AgentAuthStatusResponse {
    pub providers: Vec<AgentAuthProviderStatus>,
}

/// `POST /api/agents/auth/{provider}/login` — request body used by the
/// providers that require the user to hand a secret upfront (currently just
/// Gemini's API key). Optional for the providers whose login runs entirely
/// server-side (Codex, Claude Code).
#[derive(Debug, Deserialize, TS)]
pub struct AgentLoginRequest {
    #[serde(default)]
    pub api_key: Option<String>,
}

/// `POST /api/agents/auth/{provider}/login/submit` — second step of the
/// providers whose CLI prompts for a code after the browser flow (Claude
/// Code's `setup-token`).
#[derive(Debug, Deserialize, TS)]
pub struct AgentLoginSubmitRequest {
    pub code: String,
}

/// `POST /api/agents/auth/{provider}/login` — synchronous return values from
/// starting a login (the ongoing progress lives on the status endpoint).
#[derive(Debug, Serialize, TS)]
pub struct AgentLoginResponse {
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    /// True when the login already completed synchronously (used by the
    /// API-key flow: the write finishes before this endpoint returns).
    pub completed: bool,
}

// ============================================================================
// In-memory login state
// ============================================================================

#[derive(Default)]
struct LoginRuntime {
    /// Persistent progress reported on `GET /api/agents/auth`.
    progress: HashMap<AgentAuthProvider, AgentLoginProgress>,
    /// Background tasks for in-flight logins. Held so we can abort them when
    /// the user hits "cancel" or starts a fresh login.
    task: HashMap<AgentAuthProvider, JoinHandle<()>>,
    /// Child processes for in-flight logins. Held so we can kill them on
    /// cancel; the runtime task also cleans this up on exit.
    child: HashMap<AgentAuthProvider, Arc<Mutex<Option<Child>>>>,
    /// PTY handles (writer + child killer) for CLIs that require an
    /// interactive terminal (Claude Code). Kept separate from `child`
    /// because a `portable_pty::Child` is not the same shape as
    /// `tokio::process::Child`.
    pty: HashMap<AgentAuthProvider, Arc<Mutex<Option<PtyLogin>>>>,
}

/// Holds the pieces of a PTY-based login so the runtime can write into
/// the CLI's stdin (`submit-code`) or kill it (`cancel`/`logout`) later.
/// The `_master` field owns the master side of the PTY: dropping it closes
/// the pipe out from under the writer and the reader thread, so keep it
/// alive as long as the login is in flight.
///
/// `writer` is wrapped in `Option` because `submit_claude_code` moves it out
/// into a `spawn_blocking` task while the write happens (the PTY writer is
/// synchronous and would block the async runtime otherwise) and puts it back
/// on success so a subsequent submit — e.g. a retry after "invalid code" —
/// can reach the CLI again.
struct PtyLogin {
    writer: Option<Box<dyn std::io::Write + Send>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

static LOGIN_RUNTIME: OnceLock<Arc<Mutex<LoginRuntime>>> = OnceLock::new();

fn runtime() -> Arc<Mutex<LoginRuntime>> {
    LOGIN_RUNTIME
        .get_or_init(|| Arc::new(Mutex::new(LoginRuntime::default())))
        .clone()
}

async fn read_progress(provider: AgentAuthProvider) -> Option<AgentLoginProgress> {
    runtime().lock().await.progress.get(&provider).cloned()
}

async fn set_progress(provider: AgentAuthProvider, progress: AgentLoginProgress) {
    runtime()
        .lock()
        .await
        .progress
        .insert(provider, progress);
}

async fn update_progress<F>(provider: AgentAuthProvider, mutator: F)
where
    F: FnOnce(&mut AgentLoginProgress),
{
    let state = runtime();
    let mut rt = state.lock().await;
    if let Some(p) = rt.progress.get_mut(&provider) {
        mutator(p);
    }
}

// ============================================================================
// Provider-specific paths / CLI names
// ============================================================================

fn home_dir() -> Result<PathBuf, ApiError> {
    dirs::home_dir()
        .ok_or_else(|| ApiError::BadGateway("Could not determine $HOME".to_string()))
}

fn codex_home() -> Result<PathBuf, ApiError> {
    if let Ok(v) = std::env::var("CODEX_HOME")
        && !v.trim().is_empty()
    {
        return Ok(PathBuf::from(v));
    }
    home_dir().map(|h| h.join(".codex"))
}

fn codex_auth_file() -> Result<PathBuf, ApiError> {
    codex_home().map(|h| h.join("auth.json"))
}

fn gemini_home() -> Result<PathBuf, ApiError> {
    home_dir().map(|h| h.join(".gemini"))
}

fn gemini_env_file() -> Result<PathBuf, ApiError> {
    gemini_home().map(|h| h.join(".env"))
}

fn gemini_oauth_file() -> Result<PathBuf, ApiError> {
    gemini_home().map(|h| h.join("oauth_creds.json"))
}

fn claude_credentials_file() -> Result<PathBuf, ApiError> {
    utils::claude_credentials::claude_credentials_path()
        .ok_or_else(|| ApiError::BadGateway("Could not determine $HOME".to_string()))
}

/// Check whether the CLI needed to authenticate this provider is available.
///
/// We look for the plain binary name (installed system-wide) rather than the
/// `npx -y @scope/pkg@X` form the executors use, so a provider is only
/// reported as installed when it can be invoked without paying npm's
/// download-and-extract latency on every call.
pub(crate) async fn cli_available(provider: AgentAuthProvider) -> bool {
    let bin = match provider {
        AgentAuthProvider::Codex => "codex",
        AgentAuthProvider::Gemini => "gemini",
        AgentAuthProvider::ClaudeCode => "claude",
    };
    resolve_executable_path(bin).await.is_some()
}

/// Timestamp (epoch seconds) of the most recent modification to `path`, or
/// `None` if the file cannot be stat'd.
fn file_mtime_epoch(path: &std::path::Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Same check the worker orchestrator gates task starts on (issue #614).
pub(crate) async fn provider_connection_state(provider: AgentAuthProvider) -> (bool, Option<i64>) {
    let agent = match provider {
        AgentAuthProvider::Codex => BaseCodingAgent::Codex,
        AgentAuthProvider::Gemini => BaseCodingAgent::Gemini,
        AgentAuthProvider::ClaudeCode => BaseCodingAgent::ClaudeCode,
    };
    executors::connection::connection_state(agent).unwrap_or((false, None))
}

// ============================================================================
// Router
// ============================================================================

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/agents/auth", get(get_auth_status))
        .route("/agents/auth/{provider}/login", post(post_login))
        .route(
            "/agents/auth/{provider}/login/cancel",
            post(post_login_cancel),
        )
        .route(
            "/agents/auth/{provider}/login/submit",
            post(post_login_submit),
        )
        .route("/agents/auth/{provider}/logout", post(post_logout))
}

// ============================================================================
// Handlers
// ============================================================================

async fn get_auth_status(
    State(_deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AgentAuthStatusResponse>>, ApiError> {
    let mut providers = Vec::new();
    for provider in [
        AgentAuthProvider::Codex,
        AgentAuthProvider::ClaudeCode,
        AgentAuthProvider::Gemini,
    ] {
        let cli = cli_available(provider).await;
        let (connected, last_auth_at) = provider_connection_state(provider).await;
        providers.push(AgentAuthProviderStatus {
            provider,
            cli_available: cli,
            connected,
            last_auth_at,
            login: read_progress(provider).await,
        });
    }
    Ok(ResponseJson(ApiResponse::success(
        AgentAuthStatusResponse { providers },
    )))
}

async fn post_login(
    State(_deployment): State<DeploymentImpl>,
    Path(provider): Path<String>,
    ResponseJson(body): ResponseJson<AgentLoginRequest>,
) -> Result<ResponseJson<ApiResponse<AgentLoginResponse>>, ApiError> {
    let provider = AgentAuthProvider::from_slug(&provider)
        .ok_or_else(|| ApiError::BadRequest(format!("Unknown provider {provider}")))?;

    if !cli_available(provider).await {
        return Err(ApiError::BadRequest(format!(
            "The {} CLI is not installed on this machine.",
            provider.as_slug()
        )));
    }

    match provider {
        AgentAuthProvider::Codex => start_codex_login().await,
        AgentAuthProvider::Gemini => {
            let api_key = body
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    ApiError::BadRequest("An API key is required for Gemini.".to_string())
                })?;
            complete_gemini_login(api_key).await
        }
        AgentAuthProvider::ClaudeCode => start_claude_login().await,
    }
}

async fn post_login_submit(
    State(_deployment): State<DeploymentImpl>,
    Path(provider): Path<String>,
    ResponseJson(body): ResponseJson<AgentLoginSubmitRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let provider = AgentAuthProvider::from_slug(&provider)
        .ok_or_else(|| ApiError::BadRequest(format!("Unknown provider {provider}")))?;

    let code = body.code.trim();
    if code.is_empty() {
        return Err(ApiError::BadRequest(
            "The exchange code must not be empty.".to_string(),
        ));
    }
    // Reject obvious paste accidents: `claude setup-token` codes are opaque
    // strings, but they never contain whitespace or newlines. A pasted URL
    // (a common mistake) fails this too, giving a clearer error than
    // "invalid code" from the CLI ten seconds later.
    if code.chars().any(char::is_whitespace) {
        return Err(ApiError::BadRequest(
            "The exchange code must not contain whitespace.".to_string(),
        ));
    }

    match provider {
        AgentAuthProvider::ClaudeCode => submit_claude_code(code).await,
        _ => Err(ApiError::BadRequest(format!(
            "Provider {} does not accept a submit-code step.",
            provider.as_slug()
        ))),
    }
}

async fn post_login_cancel(
    State(_deployment): State<DeploymentImpl>,
    Path(provider): Path<String>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let provider = AgentAuthProvider::from_slug(&provider)
        .ok_or_else(|| ApiError::BadRequest(format!("Unknown provider {provider}")))?;

    stop_in_flight_login(provider).await;
    update_progress(provider, |p| {
        if matches!(p.state, AgentLoginState::Pending) {
            p.state = AgentLoginState::Failed;
            p.error = Some("Login cancelled".to_string());
        }
    })
    .await;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Kill the CLI process (child or PTY-backed) associated with `provider`
/// and abort its watcher task. Used by both cancel and logout paths so a
/// stale login cannot re-write the auth file seconds after we clear it.
async fn stop_in_flight_login(provider: AgentAuthProvider) {
    let (task, child_slot, pty_slot) = {
        let state = runtime();
        let mut rt = state.lock().await;
        (
            rt.task.remove(&provider),
            rt.child.remove(&provider),
            rt.pty.remove(&provider),
        )
    };
    if let Some(slot) = child_slot
        && let Some(mut child) = slot.lock().await.take()
    {
        let _ = child.kill().await;
    }
    if let Some(slot) = pty_slot
        && let Some(mut pty) = slot.lock().await.take()
    {
        let _ = pty.child.kill();
    }
    if let Some(task) = task {
        task.abort();
    }
}

async fn post_logout(
    State(_deployment): State<DeploymentImpl>,
    Path(provider): Path<String>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let provider = AgentAuthProvider::from_slug(&provider)
        .ok_or_else(|| ApiError::BadRequest(format!("Unknown provider {provider}")))?;

    // Kill any in-flight login before wiping credentials — otherwise the
    // still-running CLI may write the auth file back seconds after we clear
    // it, leaving the UI stuck on "connected".
    stop_in_flight_login(provider).await;

    match provider {
        AgentAuthProvider::Codex => codex_logout().await?,
        AgentAuthProvider::Gemini => gemini_logout().await?,
        AgentAuthProvider::ClaudeCode => claude_logout().await?,
    }

    // Clear the last progress record too so a stale "Completed" toast does
    // not immediately reappear after disconnecting.
    runtime().lock().await.progress.remove(&provider);
    Ok(ResponseJson(ApiResponse::success(())))
}

// ============================================================================
// Codex login: device flow via the CLI
// ============================================================================

async fn start_codex_login() -> Result<ResponseJson<ApiResponse<AgentLoginResponse>>, ApiError>
{
    // Reset any previous run — the caller explicitly asked for a fresh
    // login, so we must not return a stale code from a login that timed out
    // in the browser.
    {
        let state = runtime();
        let mut rt = state.lock().await;
        if let Some(handle) = rt.task.remove(&AgentAuthProvider::Codex) {
            handle.abort();
        }
        if let Some(slot) = rt.child.remove(&AgentAuthProvider::Codex)
            && let Some(mut child) = slot.lock().await.take()
        {
            let _ = child.kill().await;
        }
    }

    set_progress(
        AgentAuthProvider::Codex,
        AgentLoginProgress {
            state: AgentLoginState::Pending,
            verification_uri: None,
            user_code: None,
            error: None,
        },
    )
    .await;

    let codex = resolve_executable_path("codex").await.ok_or_else(|| {
        ApiError::BadRequest("The Codex CLI is not installed on this machine.".to_string())
    })?;

    let mut cmd = Command::new(&codex);
    cmd.args(["login", "--device-auth"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.no_window();

    let mut child = cmd.spawn().map_err(|e| {
        ApiError::BadGateway(format!("Failed to spawn codex login: {e}"))
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        ApiError::BadGateway("codex login: no stdout pipe".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ApiError::BadGateway("codex login: no stderr pipe".to_string())
    })?;

    let child_slot = Arc::new(Mutex::new(Some(child)));
    {
        let state = runtime();
        let mut rt = state.lock().await;
        rt.child
            .insert(AgentAuthProvider::Codex, child_slot.clone());
    }

    // Spawn readers that fold the CLI's chatter into the shared progress
    // record. Both streams write into the same slot so callers can display
    // any error the CLI printed on stderr regardless of stream ordering.
    let stdout_reader = tokio::spawn(read_codex_output(BufReader::new(stdout)));
    let stderr_reader = tokio::spawn(read_codex_output(BufReader::new(stderr)));

    let auth_file = codex_auth_file()?;
    let watcher_slot = child_slot.clone();
    let watcher = tokio::spawn(async move {
        // Wait for the CLI to exit (which happens once the browser flow
        // completes) or for the auth file to appear as a safety net.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
        loop {
            if tokio::time::Instant::now() >= deadline {
                if let Some(mut child) = watcher_slot.lock().await.take() {
                    let _ = child.kill().await;
                }
                update_progress(AgentAuthProvider::Codex, |p| {
                    p.state = AgentLoginState::Failed;
                    p.error =
                        Some("Login timed out. Please try again.".to_string());
                })
                .await;
                return;
            }
            {
                let mut guard = watcher_slot.lock().await;
                if let Some(child) = guard.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let ok = status.success() && auth_file.exists();
                            update_progress(AgentAuthProvider::Codex, |p| {
                                if ok {
                                    p.state = AgentLoginState::Completed;
                                    p.error = None;
                                } else if matches!(p.state, AgentLoginState::Pending) {
                                    p.state = AgentLoginState::Failed;
                                    if p.error.is_none() {
                                        p.error = Some(format!(
                                            "codex login exited with status {status}"
                                        ));
                                    }
                                }
                            })
                            .await;
                            guard.take();
                            let _ = stdout_reader.await;
                            let _ = stderr_reader.await;
                            return;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            update_progress(AgentAuthProvider::Codex, |p| {
                                p.state = AgentLoginState::Failed;
                                p.error =
                                    Some(format!("Failed waiting on codex login: {e}"));
                            })
                            .await;
                            guard.take();
                            return;
                        }
                    }
                } else {
                    // Cancelled externally.
                    return;
                }
            }
            sleep(Duration::from_millis(500)).await;
        }
    });

    {
        let state = runtime();
        let mut rt = state.lock().await;
        rt.task.insert(AgentAuthProvider::Codex, watcher);
    }

    // Give the CLI a moment to print the device-code line before returning.
    // 3 seconds is plenty on both a warm binary and a cold `npx` start; the
    // frontend also polls status so a slower start is not fatal.
    for _ in 0..30 {
        if let Some(p) = read_progress(AgentAuthProvider::Codex).await
            && (p.user_code.is_some() || matches!(p.state, AgentLoginState::Failed))
        {
            return Ok(ResponseJson(ApiResponse::success(AgentLoginResponse {
                verification_uri: p.verification_uri.clone(),
                user_code: p.user_code.clone(),
                completed: false,
            })));
        }
        sleep(Duration::from_millis(100)).await;
    }

    Ok(ResponseJson(ApiResponse::success(AgentLoginResponse {
        verification_uri: None,
        user_code: None,
        completed: false,
    })))
}

async fn read_codex_output<R: tokio::io::AsyncRead + Unpin>(mut reader: BufReader<R>) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // Read up to a newline; the CLI is line-oriented for the parts we
        // care about (URL then code) so anything shorter is padding around
        // them we can safely ignore. An incomplete final line (no trailing
        // `\n`, EOF hit) is inspected via `.lines()` before returning.
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => return,
            Ok(_) => {
                let stripped = strip_ansi_escapes::strip_str(String::from_utf8_lossy(&buf));
                for line in stripped.lines() {
                    apply_codex_line(line).await;
                }
            }
            Err(_) => return,
        }
    }
}

async fn apply_codex_line(line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Some(url) = extract_https_url(trimmed) {
        update_progress(AgentAuthProvider::Codex, |p| {
            p.verification_uri = Some(url);
        })
        .await;
        return;
    }
    if let Some(code) = extract_device_code(trimmed) {
        update_progress(AgentAuthProvider::Codex, |p| {
            p.user_code = Some(code);
        })
        .await;
        return;
    }
    // The CLI also prints friendly error text (e.g. "Login failed:") on
    // stderr; keep the most recent one so the UI can surface it.
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("error")
        || lower.contains("failed")
        || lower.contains("expired")
        || lower.contains("cancel")
    {
        update_progress(AgentAuthProvider::Codex, |p| {
            if !matches!(p.state, AgentLoginState::Completed) {
                p.error = Some(trimmed.to_string());
            }
        })
        .await;
    }
}

fn extract_https_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let candidate = &rest[..end];
    let trimmed = candidate.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | ']' | '"'));
    if trimmed.starts_with("https://") && trimmed.len() > "https://".len() {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Codex prints codes like `5IWI-SGY4F` on their own line: all uppercase
/// letters/digits with a single dash and at least one digit. Reject
/// anything else so we do not pick up prose like "SIGN-INTO" that happens
/// to satisfy the uppercase-only shape.
fn extract_device_code(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.contains(' ') || trimmed.contains('\t') {
        return None;
    }
    let (a, b) = trimmed.split_once('-')?;
    let is_code_segment = |s: &str| {
        !s.is_empty()
            && s.len() <= 8
            && s.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    if !is_code_segment(a) || !is_code_segment(b) {
        return None;
    }
    if !trimmed.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_string())
}

async fn codex_logout() -> Result<(), ApiError> {
    // Prefer the CLI so any server-side session is invalidated too;
    // fall back to deleting the auth file when the CLI is missing or
    // returns non-zero (which happens when the file is already gone).
    if let Some(codex) = resolve_executable_path("codex").await {
        let out = Command::new(&codex)
            .arg("logout")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => return Ok(()),
            Ok(o) => tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "`codex logout` exited unsuccessfully; falling back to file removal"
            ),
            Err(e) => tracing::warn!(?e, "failed to run `codex logout`; falling back"),
        }
    }
    if let Ok(path) = codex_auth_file()
        && path.exists()
    {
        std::fs::remove_file(&path).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to remove Codex credentials at {}: {e}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

// ============================================================================
// Gemini login: API key stored as `~/.gemini/.env`
// ============================================================================

async fn complete_gemini_login(
    api_key: &str,
) -> Result<ResponseJson<ApiResponse<AgentLoginResponse>>, ApiError> {
    if api_key.chars().any(|c| c.is_whitespace()) {
        return Err(ApiError::BadRequest(
            "The API key must not contain whitespace.".to_string(),
        ));
    }
    if api_key.len() < 20 {
        return Err(ApiError::BadRequest(
            "The API key looks too short — double-check that you copied the full value."
                .to_string(),
        ));
    }

    let dir = gemini_home()?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        ApiError::BadGateway(format!(
            "Failed to create {}: {e}",
            dir.display()
        ))
    })?;
    let env_path = gemini_env_file()?;

    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let updated = replace_or_append_env(&existing, "GEMINI_API_KEY", api_key);
    write_secret_file(&env_path, updated.as_bytes())?;

    set_progress(
        AgentAuthProvider::Gemini,
        AgentLoginProgress {
            state: AgentLoginState::Completed,
            verification_uri: None,
            user_code: None,
            error: None,
        },
    )
    .await;

    Ok(ResponseJson(ApiResponse::success(AgentLoginResponse {
        verification_uri: None,
        user_code: None,
        completed: true,
    })))
}

/// Merge a `KEY=value` pair into the given `.env`-style contents, replacing
/// an existing line for the same key (regardless of quoting) and appending
/// otherwise. Comments and unrelated variables are preserved verbatim so we
/// do not clobber other tools sharing the file.
fn replace_or_append_env(contents: &str, key: &str, value: &str) -> String {
    let mut replaced = false;
    let mut out = String::with_capacity(contents.len() + key.len() + value.len() + 2);
    for line in contents.lines() {
        let trimmed = line.trim_start();
        if !replaced && !trimmed.starts_with('#') && starts_with_var(trimmed, key) {
            out.push_str(key);
            out.push('=');
            out.push_str(value);
            out.push('\n');
            replaced = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !replaced {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

fn starts_with_var(line: &str, key: &str) -> bool {
    if !line.starts_with(key) {
        return false;
    }
    let rest = &line[key.len()..];
    rest.starts_with('=') || rest.starts_with(' ') || rest.starts_with('\t')
}

/// Write `bytes` to `path` with owner-only permissions on Unix (the file
/// carries an API key).
fn write_secret_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), ApiError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| {
                ApiError::BadGateway(format!(
                    "Failed to write {}: {e}",
                    path.display()
                ))
            })?;
        f.write_all(bytes).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to write {}: {e}",
                path.display()
            ))
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to write {}: {e}",
                path.display()
            ))
        })
    }
}

async fn gemini_logout() -> Result<(), ApiError> {
    if let Ok(env_path) = gemini_env_file()
        && env_path.exists()
    {
        let contents = std::fs::read_to_string(&env_path).unwrap_or_default();
        let stripped = remove_env_var(&contents, "GEMINI_API_KEY");
        let stripped = remove_env_var(&stripped, "GOOGLE_API_KEY");
        if stripped.trim().is_empty() {
            std::fs::remove_file(&env_path).map_err(|e| {
                ApiError::BadGateway(format!(
                    "Failed to remove {}: {e}",
                    env_path.display()
                ))
            })?;
        } else {
            write_secret_file(&env_path, stripped.as_bytes())?;
        }
    }
    if let Ok(oauth) = gemini_oauth_file()
        && oauth.exists()
    {
        std::fs::remove_file(&oauth).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to remove {}: {e}",
                oauth.display()
            ))
        })?;
    }
    Ok(())
}

fn remove_env_var(contents: &str, key: &str) -> String {
    let mut out = String::with_capacity(contents.len());
    for line in contents.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || !starts_with_var(trimmed, key) {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

// ============================================================================
// Claude Code login: OAuth PKCE via `claude setup-token`, driven through a PTY
// ============================================================================
//
// The CLI refuses to render its OAuth prompt on a bare pipe (it TTY-detects
// and stays silent), so a plain `Command::new` gets us no URL and no way to
// deliver the exchange code. We open a pseudo-terminal, spawn the CLI on the
// slave side, and treat the master as both stdout reader and stdin writer.
// The reader thread strips terminal escapes, watches for the authorize URL
// (the "Browser didn't open?" prompt prints it plainly), and pushes it into
// the shared progress record. `submit-code` writes the pasted code + newline
// back through the same master handle. On success the CLI prints the token,
// which the reader stores (`persist_claude_oauth_token`); the watcher also
// accepts a refreshed `~/.claude/.credentials.json`.
//
// The URL is presented alongside a `Paste code here if prompted >` line;
// the CLI never prints a user-friendly code itself, so `user_code` stays
// empty and the UI switches to a "paste your exchange code" input instead.

/// How long the CLI can spend waiting for the user to complete the OAuth
/// handoff before we tear it down. The setup-token flow is one browser hop
/// plus one paste, so ten minutes is generous without risking a stuck child.
const CLAUDE_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Terminal shape for the CLI's Ink renderer. Wide enough that neither the
/// authorize URL nor the printed token wrap: the URL parser can stitch a
/// wrapped URL back together, the token parser cannot.
const CLAUDE_PTY_COLS: u16 = 400;
const CLAUDE_PTY_ROWS: u16 = 40;

async fn start_claude_login()
-> Result<ResponseJson<ApiResponse<AgentLoginResponse>>, ApiError> {
    // Fresh login means fresh state: abort any prior watcher so the CLI it
    // was polling stops overwriting our progress record.
    stop_in_flight_login(AgentAuthProvider::ClaudeCode).await;

    set_progress(
        AgentAuthProvider::ClaudeCode,
        AgentLoginProgress {
            state: AgentLoginState::Pending,
            verification_uri: None,
            user_code: None,
            error: None,
        },
    )
    .await;

    let claude = resolve_executable_path("claude").await.ok_or_else(|| {
        ApiError::BadRequest(
            "The Claude Code CLI is not installed on this machine.".to_string(),
        )
    })?;
    let creds_before_mtime = claude_credentials_file()
        .ok()
        .and_then(|p| file_mtime_epoch(&p));

    let (pty_login, output_rx) = spawn_claude_pty(&claude).await?;
    let pty_slot = Arc::new(Mutex::new(Some(pty_login)));
    {
        let state = runtime();
        let mut rt = state.lock().await;
        rt.pty
            .insert(AgentAuthProvider::ClaudeCode, pty_slot.clone());
    }

    // Reader task folds CLI output into the shared progress record and
    // captures the token `setup-token` prints once the code is accepted.
    let reader = tokio::spawn(read_claude_pty_output(output_rx));

    // Watcher: waits for the reader to capture the token, for the CLI to
    // exit, or for the credentials file to appear/refresh.
    let watcher_slot = pty_slot.clone();
    let watcher = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + CLAUDE_LOGIN_TIMEOUT;
        let creds_path = claude_credentials_file().ok();
        loop {
            if tokio::time::Instant::now() >= deadline {
                if let Some(mut pty) = watcher_slot.lock().await.take() {
                    let _ = pty.child.kill();
                }
                update_progress(AgentAuthProvider::ClaudeCode, |p| {
                    if !matches!(p.state, AgentLoginState::Completed) {
                        p.state = AgentLoginState::Failed;
                        p.error = Some(
                            "Login timed out. Please try again.".to_string(),
                        );
                    }
                })
                .await;
                return;
            }

            // The reader stored the token (the `setup-token` path), or an
            // interactive login refreshed the credentials file. Either way
            // the CLI has done its job: flip to "connected" and kill it.
            let token_captured = matches!(
                read_progress(AgentAuthProvider::ClaudeCode).await,
                Some(AgentLoginProgress { state: AgentLoginState::Completed, .. })
            );
            let creds_refreshed = creds_path
                .as_deref()
                .is_some_and(|p| p.exists() && file_mtime_epoch(p) != creds_before_mtime);
            if token_captured || creds_refreshed {
                update_progress(AgentAuthProvider::ClaudeCode, |p| {
                    p.state = AgentLoginState::Completed;
                    p.error = None;
                })
                .await;
                if let Some(mut pty) = watcher_slot.lock().await.take() {
                    let _ = pty.child.kill();
                }
                return;
            }

            // Child exit check.
            let exit = {
                let mut guard = watcher_slot.lock().await;
                let Some(pty) = guard.as_mut() else {
                    // Torn down by cancel/logout — nothing left to do.
                    return;
                };
                let exit = match pty.child.try_wait() {
                    Ok(None) => None,
                    Ok(Some(status)) => Some(format!("exit code {}", status.exit_code())),
                    Err(e) => Some(format!("failed waiting on claude: {e}")),
                };
                if exit.is_some() {
                    // Dropping the PTY closes the master so the reader
                    // drains the last output and hits EOF.
                    guard.take();
                }
                exit
            };
            if let Some(exit) = exit {
                // `setup-token` prints the token right before exiting: let
                // the reader fold that final output before judging.
                let _ = tokio::time::timeout(Duration::from_secs(3), reader).await;
                let creds_refreshed = creds_path
                    .as_deref()
                    .is_some_and(|p| p.exists() && file_mtime_epoch(p) != creds_before_mtime);
                update_progress(AgentAuthProvider::ClaudeCode, |p| {
                    if creds_refreshed {
                        p.state = AgentLoginState::Completed;
                        p.error = None;
                    } else if matches!(p.state, AgentLoginState::Pending) {
                        p.state = AgentLoginState::Failed;
                        let reason = p.error.take().unwrap_or_else(|| {
                            "Claude finished without returning a usable token".to_string()
                        });
                        p.error = Some(format!(
                            "{reason} ({exit}). Click Connect to try again."
                        ));
                    }
                })
                .await;
                return;
            }

            sleep(Duration::from_millis(500)).await;
        }
    });
    {
        let state = runtime();
        let mut rt = state.lock().await;
        rt.task.insert(AgentAuthProvider::ClaudeCode, watcher);
    }

    // Return immediately: the frontend polls `GET /agents/auth` on a
    // 2s tick while a login is `Pending`, so the URL surfaces there as
    // soon as the reader task parses it out of the PTY. Blocking the
    // "Connect" click on a synchronous URL wait adds visible latency
    // (up to a few seconds on a cold `npx` fetch) for no benefit.
    Ok(ResponseJson(ApiResponse::success(AgentLoginResponse {
        verification_uri: None,
        user_code: None,
        completed: false,
    })))
}

/// Open a PTY, spawn `claude setup-token` on the slave side, and hand back a
/// writer for stdin plus a channel for stdout.
async fn spawn_claude_pty(
    claude: &std::path::Path,
) -> Result<(PtyLogin, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>), ApiError> {
    let claude = claude.to_path_buf();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let spawn_result = tokio::task::spawn_blocking(move || {
        let pty_system = NativePtySystem::default();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: CLAUDE_PTY_ROWS,
                cols: CLAUDE_PTY_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(&claude);
        cmd.arg("setup-token");
        // Signal a real terminal so the CLI's Ink renderer picks the
        // interactive prompt path we need to parse.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Suppress its "open browser?" attempt: on a headless VPS there is
        // no browser to open, and letting the CLI try it prints nothing
        // useful and delays the URL.
        cmd.env("BROWSER", "true");

        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn claude setup-token: {e}"))?;

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to get pty writer: {e}"))?;

        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;

        // Reader lives on its own OS thread: portable_pty's master reader
        // is blocking, so mixing it with the tokio runtime would stall it.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok::<_, String>(PtyLogin {
            writer: Some(writer),
            child,
            _master: pty_pair.master,
        })
    })
    .await
    .map_err(|e| ApiError::BadGateway(format!("PTY task join failed: {e}")))?
    .map_err(ApiError::BadGateway)?;

    Ok((spawn_result, rx))
}

/// Fold PTY stdout into the shared progress record. Runs until the reader
/// side closes (child exited or PTY torn down).
async fn read_claude_pty_output(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
) {
    // Accumulate raw bytes across chunks so we can strip escapes over the
    // whole stream (URL segments arrive across multiple reads). Cap the
    // buffer so a chatty CLI cannot balloon our memory.
    let mut acc: Vec<u8> = Vec::new();
    while let Some(chunk) = rx.recv().await {
        acc.extend_from_slice(&chunk);
        if acc.len() > 64 * 1024 {
            // Drop the oldest half; the URL always appears near the end of
            // the stream so trimming from the front is safe.
            acc.drain(..acc.len() / 2);
        }
        let text = strip_ansi_escapes::strip_str(String::from_utf8_lossy(&acc));
        if let Some(url) = extract_claude_authorize_url(&text) {
            update_progress(AgentAuthProvider::ClaudeCode, |p| {
                if p.verification_uri.is_none() {
                    p.verification_uri = Some(url.clone());
                }
            })
            .await;
        } else if text.contains("oauth/authorize") {
            update_progress(AgentAuthProvider::ClaudeCode, |p| {
                if p.verification_uri.is_none() && p.error.is_none() {
                    p.error = Some(
                        "Claude printed a sign-in URL on an unrecognized host, so it was \
                         not opened. Update fluke to connect Claude."
                            .to_string(),
                    );
                }
            })
            .await;
        }

        // Errors are matched on the fresh chunk only, so a retry after an
        // invalid code is not re-flagged by the stale output in `acc`.
        let fresh = strip_ansi_escapes::strip_str(String::from_utf8_lossy(&chunk))
            .to_ascii_lowercase();
        if fresh.contains("invalid code")
            || fresh.contains("authentication failed")
            || fresh.contains("oauth error")
        {
            update_progress(AgentAuthProvider::ClaudeCode, |p| {
                if !matches!(p.state, AgentLoginState::Completed) {
                    p.error = Some(
                        "The code was rejected. Copy it again from the sign-in page and \
                         submit it"
                            .to_string(),
                    );
                }
            })
            .await;
        }

        if let Some(token) = extract_claude_oauth_token(&acc) {
            let result = persist_claude_oauth_token(&token);
            update_progress(AgentAuthProvider::ClaudeCode, |p| match result {
                Ok(()) => {
                    p.state = AgentLoginState::Completed;
                    p.error = None;
                }
                Err(e) => {
                    p.state = AgentLoginState::Failed;
                    p.error = Some(e);
                }
            })
            .await;
            return;
        }
    }
}

/// Pluck the `sk-ant-oat…` token `claude setup-token` prints once the code
/// is accepted. Escape sequences are turned into separators before
/// stripping: ConPTY repaints with cursor moves instead of newlines, and
/// removing them outright would glue the following text onto the token.
/// Returns `None` while the token may still be streaming in (nothing after
/// it yet), so a chunk boundary never yields a truncated token.
fn extract_claude_oauth_token(raw: &[u8]) -> Option<String> {
    let mut spaced = Vec::with_capacity(raw.len());
    for &b in raw {
        if b == 0x1b {
            spaced.push(b' ');
        }
        spaced.push(b);
    }
    let text = strip_ansi_escapes::strip_str(String::from_utf8_lossy(&spaced));
    let rest = &text[text.find("sk-ant-oat")?..];
    let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))?;
    (len >= 60).then(|| rest[..len].to_string())
}

/// Store the token where the executor reads it
/// (`executors::executors::claude::stored_claude_oauth_token`).
fn persist_claude_oauth_token(token: &str) -> Result<(), String> {
    let path = claude_oauth_token_path()
        .ok_or_else(|| "Could not determine the Claude config directory".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    }
    write_secret_file(&path, token.as_bytes()).map_err(|e| format!("{e:?}"))
}

/// Pluck the authorize URL out of the (already ANSI-stripped) CLI output.
/// The CLI wraps the URL across three lines on narrow terminals and we
/// sometimes catch it mid-render, so we walk the text as a single string
/// and stitch it back together, treating a single wrap (one whitespace
/// character) as part of the URL and two-or-more consecutive whitespace
/// chars as end-of-URL (which is what the CLI prints before the "Paste
/// code here" prompt).
///
/// The origins are allowlisted deliberately: accepting any host would let a
/// hostile output (interpolated MOTD, malicious npm package, ...) steer
/// users to a phishing origin. An authorize URL on any other host surfaces
/// as an error on the card (see `read_claude_pty_output`); this list is the
/// place to update when the CLI moves its endpoint.
const CLAUDE_AUTHORIZE_ORIGINS: &[&str] = &[
    "https://claude.com/",
    "https://claude.ai/",
    "https://platform.claude.com/",
    "https://console.anthropic.com/",
];

fn extract_claude_authorize_url(text: &str) -> Option<String> {
    let (start, origin) = CLAUDE_AUTHORIZE_ORIGINS
        .iter()
        .filter_map(|origin| text.find(origin).map(|i| (i, *origin)))
        .min_by_key(|(i, _)| *i)?;
    let rest = &text[start..];
    let mut url = String::new();
    let mut consecutive_ws = 0usize;
    for ch in rest.chars() {
        if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' {
            break;
        }
        if ch == '\n' || ch == '\r' || ch == '\t' || ch == ' ' {
            consecutive_ws += 1;
            if consecutive_ws >= 2 {
                break;
            }
            continue;
        }
        consecutive_ws = 0;
        url.push(ch);
    }
    // Trim any trailing punctuation the CLI printed on the same line.
    let trimmed = url.trim_end_matches(|c: char| {
        matches!(c, '.' | ',' | ')' | ']' | '"' | '>')
    });
    if trimmed.starts_with(origin) && trimmed.len() > 40 {
        Some(trimmed.to_string())
    } else {
        None
    }
}

async fn submit_claude_code(code: &str) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let slot = {
        let state = runtime();
        let rt = state.lock().await;
        rt.pty.get(&AgentAuthProvider::ClaudeCode).cloned()
    };
    let slot = slot.ok_or_else(|| {
        ApiError::BadRequest(
            "No Claude Code login is in progress. Start the connection first."
                .to_string(),
        )
    })?;

    // Take the writer out of the slot so we can run the blocking write on a
    // dedicated thread without holding the async mutex across the syscall.
    // Put it back on success so a retry after "invalid code" can still reach
    // the CLI; tear the whole login down on failure so `Pending` doesn't get
    // stuck when the child has already died.
    let writer = {
        let mut guard = slot.lock().await;
        let pty = guard.as_mut().ok_or_else(|| {
            ApiError::BadRequest(
                "The Claude Code login has already finished.".to_string(),
            )
        })?;
        pty.writer.take().ok_or_else(|| {
            ApiError::BadRequest(
                "A previous exchange code is still being submitted.".to_string(),
            )
        })?
    };

    // Write the code and a carriage return: the CLI treats CR as "enter" on
    // its Ink prompt, so this submits the value the same way a keyboard
    // paste would. The write runs inside `spawn_blocking` because
    // `pty.writer` is a synchronous `Write` (portable_pty does not expose an
    // async writer) and we would otherwise stall the async runtime while
    // the pipe drains. Payload is ~20 bytes so it should complete in
    // microseconds, but the wrapping keeps the runtime honest.
    let mut payload = code.as_bytes().to_vec();
    payload.push(b'\r');

    // A retry after "code rejected" starts clean; the reader re-flags it if
    // the CLI rejects this code too.
    update_progress(AgentAuthProvider::ClaudeCode, |p| p.error = None).await;

    let write_result = tokio::task::spawn_blocking(move || {
        let mut writer = writer;
        writer.write_all(&payload)?;
        writer.flush()?;
        Ok::<_, std::io::Error>(writer)
    })
    .await
    .map_err(|e| ApiError::BadGateway(format!("submit_claude_code join failed: {e}")))?;

    match write_result {
        Ok(writer) => {
            let mut guard = slot.lock().await;
            if let Some(pty) = guard.as_mut() {
                pty.writer = Some(writer);
            }
            Ok(ResponseJson(ApiResponse::success(())))
        }
        Err(e) => {
            // The child is gone or the PTY closed: without cleanup the
            // runtime would keep the login as `Pending` forever, blocking
            // any retry from the UI. Reuse `stop_in_flight_login` so the
            // watcher task, child handle and PTY slot are all released, and
            // flip the progress record to `Failed` so the frontend surfaces
            // a real error instead of an endless spinner.
            stop_in_flight_login(AgentAuthProvider::ClaudeCode).await;
            let err_msg = format!("Failed to write to claude stdin: {e}");
            update_progress(AgentAuthProvider::ClaudeCode, |p| {
                if !matches!(p.state, AgentLoginState::Completed) {
                    p.state = AgentLoginState::Failed;
                    if p.error.is_none() {
                        p.error = Some(err_msg.clone());
                    }
                }
            })
            .await;
            Err(ApiError::BadGateway(err_msg))
        }
    }
}

async fn claude_logout() -> Result<(), ApiError> {
    // The token captured by Settings is fluke's own file: the CLI does not
    // know about it, so remove it before (and regardless of) its logout.
    if let Some(path) = claude_oauth_token_path()
        && path.exists()
    {
        std::fs::remove_file(&path).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to remove the Claude token at {}: {e}",
                path.display()
            ))
        })?;
    }
    // Prefer the CLI so any server-side session is invalidated too;
    // fall back to removing the credentials file when the CLI is missing
    // or exits non-zero (which happens when the file is already gone).
    if let Some(claude) = resolve_executable_path("claude").await {
        let out = Command::new(&claude)
            .args(["auth", "logout"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => return Ok(()),
            Ok(o) => tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "`claude auth logout` exited unsuccessfully; falling back to file removal"
            ),
            Err(e) => tracing::warn!(?e, "failed to run `claude auth logout`; falling back"),
        }
    }
    if let Ok(path) = claude_credentials_file()
        && path.exists()
    {
        std::fs::remove_file(&path).map_err(|e| {
            ApiError::BadGateway(format!(
                "Failed to remove Claude credentials at {}: {e}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_codex_verification_url() {
        let line = "   https://auth.openai.com/codex/device";
        assert_eq!(
            extract_https_url(line).as_deref(),
            Some("https://auth.openai.com/codex/device")
        );
    }

    #[test]
    fn strips_trailing_punctuation_from_urls() {
        assert_eq!(
            extract_https_url("see https://example.com/foo.").as_deref(),
            Some("https://example.com/foo")
        );
    }

    #[test]
    fn extracts_uppercase_dashed_code() {
        assert_eq!(
            extract_device_code("5IWI-SGY4F").as_deref(),
            Some("5IWI-SGY4F")
        );
    }

    #[test]
    fn ignores_prose_that_happens_to_contain_dashes() {
        assert!(extract_device_code("open your browser to sign-in").is_none());
        assert!(extract_device_code("hello-world foo").is_none());
        // Lowercase segments are prose, not a code.
        assert!(extract_device_code("abcd-1234").is_none());
        // All uppercase but no digits — e.g. "SIGN-INTO" — is prose.
        assert!(extract_device_code("SIGN-INTO").is_none());
    }

    #[test]
    fn replaces_existing_env_var() {
        let updated = replace_or_append_env(
            "OTHER=1\nGEMINI_API_KEY=stale\n# comment\n",
            "GEMINI_API_KEY",
            "fresh",
        );
        assert!(updated.contains("GEMINI_API_KEY=fresh"));
        assert!(!updated.contains("stale"));
        assert!(updated.contains("OTHER=1"));
        assert!(updated.contains("# comment"));
    }

    #[test]
    fn appends_missing_env_var() {
        let updated = replace_or_append_env("OTHER=1\n", "GEMINI_API_KEY", "fresh");
        assert!(updated.ends_with("GEMINI_API_KEY=fresh\n"));
        assert!(updated.contains("OTHER=1"));
    }

    #[test]
    fn removes_only_targeted_env_var() {
        let stripped = remove_env_var(
            "OTHER=1\nGEMINI_API_KEY=stale\n# comment\n",
            "GEMINI_API_KEY",
        );
        assert!(!stripped.contains("GEMINI_API_KEY"));
        assert!(stripped.contains("OTHER=1"));
        assert!(stripped.contains("# comment"));
    }

    #[test]
    fn does_not_touch_lookalike_env_var() {
        let stripped =
            remove_env_var("GEMINI_API_KEY_OLD=x\n", "GEMINI_API_KEY");
        assert!(stripped.contains("GEMINI_API_KEY_OLD=x"));
    }

    #[test]
    fn extracts_claude_authorize_url_from_wrapped_output() {
        // The Ink renderer breaks the URL across multiple lines on
        // narrow terminals; the parser has to stitch them back together.
        let sample = "Browser didn't open? Use the url below to sign in\n\n\
            https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\n\
            ed-5944d1962f5e&response_type=code&scope=user%3Ainference&code_challenge=abcd\n\n\
            Paste code here if prompted >";
        let url = extract_claude_authorize_url(sample).expect("URL must parse");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?code=true"));
        assert!(url.contains("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"));
        assert!(!url.contains(' '));
        assert!(!url.contains('\n'));
    }

    #[test]
    fn claude_url_extractor_ignores_output_without_url() {
        assert!(extract_claude_authorize_url("Waiting for browser…").is_none());
        // Different origin — do not accept: the CLI only ever prints
        // claude.com URLs, anything else is a masquerade.
        assert!(extract_claude_authorize_url("https://example.com/oauth").is_none());
    }

    #[test]
    fn claude_url_extractor_stops_before_paste_prompt() {
        // Regression: an earlier version kept reading past the URL and
        // glued the "Paste code here" prompt onto the end.
        let sample = "https://claude.com/cai/oauth/authorize?state=abcd&client_id=xyzxyzxyz\n\n\
            Paste code here if prompted >";
        let url = extract_claude_authorize_url(sample).expect("URL must parse");
        assert!(!url.contains("Paste"));
        assert!(url.ends_with("client_id=xyzxyzxyz"));
    }

    #[test]
    fn claude_url_extractor_accepts_other_anthropic_hosts() {
        let url = extract_claude_authorize_url(
            "https://claude.ai/oauth/authorize?code=true&client_id=abcdefghijklmnop\n\n",
        )
        .expect("URL must parse");
        assert!(url.starts_with("https://claude.ai/oauth/authorize"));
    }

    const TOKEN: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

    #[test]
    fn extracts_claude_oauth_token() {
        let out = format!(
            "\x1b[32mYour OAuth token (valid for 1 year):\x1b[39m\r\n\r\n{TOKEN}\r\n\r\nStore this token securely."
        );
        assert_eq!(extract_claude_oauth_token(out.as_bytes()).as_deref(), Some(TOKEN));
        // A cursor move right after the token must not glue the next text on.
        let repainted = format!("{TOKEN}\x1b[5;1HStore this token");
        assert_eq!(
            extract_claude_oauth_token(repainted.as_bytes()).as_deref(),
            Some(TOKEN)
        );
    }

    #[test]
    fn waits_for_the_whole_claude_token() {
        // Chunk boundary: nothing after the token yet, it may still grow.
        assert!(extract_claude_oauth_token(TOKEN.as_bytes()).is_none());
        assert!(extract_claude_oauth_token(b"no token here\n").is_none());
    }
}
