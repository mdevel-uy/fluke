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
//!
//! Providers whose CLI is not installed on the image are still reported so
//! the UI can hide their card; the check reuses the same executable
//! resolution the executors use to spawn the CLI.

use std::{
    collections::HashMap,
    io::Write as _,
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
/// here — Claude Code is tracked separately by issue #343 and other agents
/// (Cursor, Amp, Copilot, ...) run through the workspace-scoped setup
/// helper.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentAuthProvider {
    Codex,
    Gemini,
}

impl AgentAuthProvider {
    fn as_slug(self) -> &'static str {
        match self {
            AgentAuthProvider::Codex => "codex",
            AgentAuthProvider::Gemini => "gemini",
        }
    }

    fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            "codex" => Some(AgentAuthProvider::Codex),
            "gemini" => Some(AgentAuthProvider::Gemini),
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
/// server-side (Codex).
#[derive(Debug, Deserialize, TS)]
pub struct AgentLoginRequest {
    #[serde(default)]
    pub api_key: Option<String>,
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

/// Check whether the CLI needed to authenticate this provider is available.
///
/// We look for the plain binary name (installed system-wide) rather than the
/// `npx -y @scope/pkg@X` form the executors use, so a provider is only
/// reported as installed when it can be invoked without paying npm's
/// download-and-extract latency on every call.
async fn cli_available(provider: AgentAuthProvider) -> bool {
    let bin = match provider {
        AgentAuthProvider::Codex => "codex",
        AgentAuthProvider::Gemini => "gemini",
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

async fn provider_connection_state(
    provider: AgentAuthProvider,
) -> (bool, Option<i64>) {
    let candidates: Vec<PathBuf> = match provider {
        AgentAuthProvider::Codex => codex_auth_file().ok().into_iter().collect(),
        AgentAuthProvider::Gemini => [gemini_env_file().ok(), gemini_oauth_file().ok()]
            .into_iter()
            .flatten()
            .collect(),
    };

    let mut best: Option<i64> = None;
    let mut connected = false;
    for c in candidates {
        if !c.exists() {
            continue;
        }
        // Gemini's `.env` may exist without our key (unlikely but possible if
        // the user edited it manually). Treat it as connected only when the
        // recognisable variable is present.
        if provider == AgentAuthProvider::Gemini
            && c.file_name().and_then(|n| n.to_str()) == Some(".env")
            && !gemini_env_has_key(&c)
        {
            continue;
        }
        connected = true;
        if let Some(ts) = file_mtime_epoch(&c) {
            best = Some(best.map_or(ts, |cur| cur.max(ts)));
        }
    }
    (connected, best)
}

fn gemini_env_has_key(path: &std::path::Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(contents) => contents.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("GEMINI_API_KEY=") || trimmed.starts_with("GOOGLE_API_KEY=")
        }),
        Err(_) => false,
    }
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
        .route("/agents/auth/{provider}/logout", post(post_logout))
}

// ============================================================================
// Handlers
// ============================================================================

async fn get_auth_status(
    State(_deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AgentAuthStatusResponse>>, ApiError> {
    let mut providers = Vec::new();
    for provider in [AgentAuthProvider::Codex, AgentAuthProvider::Gemini] {
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
    }
}

async fn post_login_cancel(
    State(_deployment): State<DeploymentImpl>,
    Path(provider): Path<String>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let provider = AgentAuthProvider::from_slug(&provider)
        .ok_or_else(|| ApiError::BadRequest(format!("Unknown provider {provider}")))?;

    let (task, child_slot) = {
        let state = runtime();
        let mut rt = state.lock().await;
        (rt.task.remove(&provider), rt.child.remove(&provider))
    };
    if let Some(slot) = child_slot
        && let Some(mut child) = slot.lock().await.take()
    {
        let _ = child.kill().await;
    }
    if let Some(task) = task {
        task.abort();
    }
    update_progress(provider, |p| {
        if matches!(p.state, AgentLoginState::Pending) {
            p.state = AgentLoginState::Failed;
            p.error = Some("Login cancelled".to_string());
        }
    })
    .await;
    Ok(ResponseJson(ApiResponse::success(())))
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
    let (task, child_slot) = {
        let state = runtime();
        let mut rt = state.lock().await;
        (rt.task.remove(&provider), rt.child.remove(&provider))
    };
    if let Some(slot) = child_slot
        && let Some(mut child) = slot.lock().await.take()
    {
        let _ = child.kill().await;
    }
    if let Some(task) = task {
        task.abort();
    }

    match provider {
        AgentAuthProvider::Codex => codex_logout().await?,
        AgentAuthProvider::Gemini => gemini_logout().await?,
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
}
