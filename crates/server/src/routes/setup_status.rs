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

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::agent_auth::{AgentAuthProvider, cli_available, provider_connection_state},
};

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
    /// At least one coding-agent CLI is reachable AND has usable credentials
    /// (same check as `GET /api/agents/auth`).
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

/// Any of the supported coding-agent CLIs is both installed *and* has usable
/// credentials: the same check Settings shows per provider
/// (`crate::routes::agent_auth::provider_connection_state`).
async fn check_agent_connected() -> bool {
    for provider in [
        AgentAuthProvider::ClaudeCode,
        AgentAuthProvider::Codex,
        AgentAuthProvider::Gemini,
    ] {
        if cli_available(provider).await && provider_connection_state(provider).await.0 {
            return true;
        }
    }
    false
}
