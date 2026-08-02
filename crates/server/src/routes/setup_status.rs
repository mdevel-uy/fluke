//! `GET /api/setup-status` — snapshot of the onboarding wizard checklist.
//!
//! The Home wizard polls this endpoint while any step is missing and hides
//! itself once all four flags flip to `true`. Each signal is kept cheap:
//! only local disk / DB reads, no outbound network calls. GitHub in
//! particular is judged by "do we have credentials on file" (config PAT /
//! OAuth token, or a `gh` CLI session that reports authenticated); this
//! matches the same source of truth `GET /api/github/status` uses without
//! probing GitHub on every poll.

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::{response::ApiResponse, shell::resolve_executable_path};

use crate::{DeploymentImpl, error::ApiError};

/// Snapshot of the four onboarding steps. `is_complete` is a convenience
/// field so the frontend does not have to re-implement the AND across
/// signals — the endpoint remains the single source of truth for "wizard
/// done".
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SetupStatusResponse {
    /// A GitHub credential is on file (PAT, OAuth token, or authenticated
    /// `gh` CLI). Does not perform a network round trip.
    pub github_connected: bool,
    /// At least one repository is registered in the local DB.
    pub repo_added: bool,
    /// At least one coding-agent CLI is reachable AND has an auth artifact
    /// on disk — Claude Code (`~/.claude/.credentials.json` etc.), Codex
    /// (`~/.codex/auth.json`), or Gemini (`GEMINI_API_KEY` in `~/.gemini/.env`
    /// or `~/.gemini/oauth_creds.json`).
    pub agent_connected: bool,
    /// At least one worker task has been enqueued. Reflects "the user has
    /// actually pushed something into the pipeline", which is the last hop
    /// before an agent produces a PR.
    pub task_created: bool,
    /// True iff all four signals above are `true`. Frontend can hide the
    /// wizard as soon as this flips.
    pub is_complete: bool,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/setup-status", get(get_setup_status))
}

async fn get_setup_status(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<SetupStatusResponse>>, ApiError> {
    let github_connected = check_github_connected(&deployment).await;
    let repo_added = check_repo_added(&deployment).await;
    let agent_connected = check_agent_connected().await;
    let task_created = check_task_created(&deployment).await;

    let is_complete = github_connected && repo_added && agent_connected && task_created;

    Ok(ResponseJson(ApiResponse::success(SetupStatusResponse {
        github_connected,
        repo_added,
        agent_connected,
        task_created,
        is_complete,
    })))
}

async fn check_github_connected(deployment: &DeploymentImpl) -> bool {
    let github = deployment.config().read().await.github.clone();
    let has_config_token = github.pat.as_deref().is_some_and(|s| !s.trim().is_empty())
        || github
            .oauth_token
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
    if has_config_token {
        return true;
    }
    if resolve_executable_path("gh").await.is_some() {
        return gh_cli_authenticated().await;
    }
    false
}

/// Best-effort probe of `gh auth status`. We only care about the exit code —
/// zero means the CLI has a live session for at least one host.
async fn gh_cli_authenticated() -> bool {
    use std::process::Stdio;

    use tokio::process::Command;
    use utils::command_ext::NoWindowExt;

    let Some(gh) = resolve_executable_path("gh").await else {
        return false;
    };
    Command::new(gh)
        .args(["auth", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window()
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn check_repo_added(deployment: &DeploymentImpl) -> bool {
    match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM repos")
        .fetch_one(&deployment.db().pool)
        .await
    {
        Ok(n) => n > 0,
        Err(e) => {
            tracing::warn!("setup-status: failed to count repos: {e}");
            false
        }
    }
}

async fn check_task_created(deployment: &DeploymentImpl) -> bool {
    match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM worker_tasks")
        .fetch_one(&deployment.db().pool)
        .await
    {
        Ok(n) => n > 0,
        Err(e) => {
            tracing::warn!("setup-status: failed to count worker_tasks: {e}");
            false
        }
    }
}

/// Any of the supported coding-agent CLIs is both installed *and* has an
/// auth artifact on disk. Mirrors the connect-state logic in
/// `crate::routes::agent_auth::provider_connection_state` for Codex/Gemini
/// and adds a lightweight check for Claude Code's credentials file so the
/// default install path (Claude only) is not stuck on "not connected".
async fn check_agent_connected() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };

    // Claude Code: the CLI writes one of these when the user finishes
    // `claude login`. Any of them counts as "connected".
    let claude_candidates = [
        home.join(".claude").join(".credentials.json"),
        home.join(".claude").join("credentials.json"),
        home.join(".config").join("claude").join("credentials.json"),
    ];
    if resolve_executable_path("claude").await.is_some()
        && claude_candidates.iter().any(|p| p.exists())
    {
        return true;
    }

    // Codex: `codex login --device-auth` writes `~/.codex/auth.json`.
    let codex_auth = home.join(".codex").join("auth.json");
    if resolve_executable_path("codex").await.is_some() && codex_auth.exists() {
        return true;
    }

    // Gemini: either the API-key `.env` (with a recognised key) or the OAuth
    // creds file counts.
    let gemini_env = home.join(".gemini").join(".env");
    let gemini_oauth = home.join(".gemini").join("oauth_creds.json");
    if resolve_executable_path("gemini").await.is_some()
        && (gemini_env_has_key(&gemini_env) || gemini_oauth.exists())
    {
        return true;
    }

    false
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
