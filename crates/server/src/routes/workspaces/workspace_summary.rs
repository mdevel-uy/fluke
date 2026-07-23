use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

use axum::{Json, extract::State, response::Json as ResponseJson};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    merge::MergeStatus,
    pull_request::PullRequest,
    workspace::Workspace,
};
use deployment::Deployment;
use executors::logs::TokenUsageInfo;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::{log_msg::LogMsg, response::ApiResponse};
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Request for fetching workspace summaries
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct WorkspaceSummaryRequest {
    pub archived: bool,
}

/// Summary info for a single workspace
#[derive(Debug, Serialize, TS)]
pub struct WorkspaceSummary {
    pub workspace_id: Uuid,
    /// Session ID of the latest execution process
    pub latest_session_id: Option<Uuid>,
    /// Is a tool approval currently pending?
    pub has_pending_approval: bool,
    /// Number of files with changes
    pub files_changed: Option<usize>,
    /// Total lines added across all files
    pub lines_added: Option<usize>,
    /// Total lines removed across all files
    pub lines_removed: Option<usize>,
    /// When the latest execution process completed
    #[ts(optional)]
    pub latest_process_completed_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Status of the latest execution process
    pub latest_process_status: Option<ExecutionProcessStatus>,
    /// Is a dev server currently running?
    pub has_running_dev_server: bool,
    /// Does this workspace have unseen coding agent turns?
    pub has_unseen_turns: bool,
    /// PR status for this workspace (if any PR exists)
    pub pr_status: Option<MergeStatus>,
    /// PR number for this workspace (if any PR exists)
    pub pr_number: Option<i64>,
    /// PR URL for this workspace (if any PR exists)
    pub pr_url: Option<String>,
    /// Mergeable state of the open PR: "mergeable", "conflicting", "unknown", or null.
    pub pr_mergeable: Option<String>,
    /// Context-window usage of the latest coding-agent session, if known
    pub latest_context_usage: Option<TokenUsageInfo>,
    /// When the latest coding-agent process started (for elapsed-time display)
    #[ts(optional)]
    pub latest_process_started_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Response containing summaries for requested workspaces
#[derive(Debug, Serialize, TS)]
pub struct WorkspaceSummaryResponse {
    pub summaries: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct DiffStats {
    pub files_changed: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
}

/// Fetch summary information for workspaces filtered by archived status.
/// This endpoint returns data that cannot be efficiently included in the streaming endpoint.
#[axum::debug_handler]
pub async fn get_workspace_summaries(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<WorkspaceSummaryRequest>,
) -> Result<ResponseJson<ApiResponse<WorkspaceSummaryResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let archived = request.archived;

    // 1. Fetch all workspaces with the given archived status
    let workspaces: Vec<Workspace> = Workspace::find_all_with_status(pool, Some(archived), None)
        .await?
        .into_iter()
        .map(|ws| ws.workspace)
        .collect();

    if workspaces.is_empty() {
        return Ok(ResponseJson(ApiResponse::success(
            WorkspaceSummaryResponse { summaries: vec![] },
        )));
    }

    // 2. Fetch latest process info for workspaces with this archived status
    let latest_processes = ExecutionProcess::find_latest_for_workspaces(pool, archived).await?;

    // 3. Check which workspaces have running dev servers
    let dev_server_workspaces =
        ExecutionProcess::find_workspaces_with_running_dev_servers(pool, archived).await?;

    // 4. Check pending approvals for running processes
    let running_ep_ids: Vec<_> = latest_processes
        .values()
        .filter(|info| info.status == ExecutionProcessStatus::Running)
        .map(|info| info.execution_process_id)
        .collect();
    let pending_approval_eps = deployment
        .approvals()
        .get_pending_execution_process_ids(&running_ep_ids);

    // 5. Check which workspaces have unseen coding agent turns
    let unseen_workspaces = CodingAgentTurn::find_workspaces_with_unseen(pool, archived).await?;

    // 6. Get PR status for each workspace
    let pr_statuses = PullRequest::get_latest_for_workspaces(pool, archived).await?;

    // 7. Latest coding-agent process per workspace: context usage + started_at
    let coding_agent_processes =
        ExecutionProcess::find_latest_coding_agent_for_workspaces(pool, archived).await?;
    let usage_futures: Vec<_> = coding_agent_processes
        .values()
        .map(|info| {
            let execution_id = info.execution_process_id;
            let workspace_id = info.workspace_id;
            let deployment = deployment.clone();
            async move {
                find_latest_context_usage(&deployment, execution_id)
                    .await
                    .map(|usage| (workspace_id, usage))
            }
        })
        .collect();
    let context_usage: HashMap<Uuid, TokenUsageInfo> =
        futures_util::future::join_all(usage_futures)
            .await
            .into_iter()
            .flatten()
            .collect();

    // 8. Compute diff stats for each workspace (in parallel)
    let diff_futures: Vec<_> = workspaces
        .iter()
        .map(|ws| {
            let workspace = ws.clone();
            let deployment = deployment.clone();
            async move {
                if workspace.container_ref.is_some() {
                    compute_workspace_diff_stats(&deployment, &workspace)
                        .await
                        .map(|stats| (workspace.id, stats))
                } else {
                    None
                }
            }
        })
        .collect();

    let diff_results: Vec<Option<(Uuid, DiffStats)>> =
        futures_util::future::join_all(diff_futures).await;
    let diff_stats: HashMap<Uuid, DiffStats> = diff_results.into_iter().flatten().collect();

    // 9. Assemble response
    let summaries: Vec<WorkspaceSummary> = workspaces
        .iter()
        .map(|ws| {
            let id = ws.id;
            let latest = latest_processes.get(&id);
            let has_pending = latest
                .map(|p| pending_approval_eps.contains(&p.execution_process_id))
                .unwrap_or(false);
            let stats = diff_stats.get(&id);

            WorkspaceSummary {
                workspace_id: id,
                latest_session_id: latest.map(|p| p.session_id),
                has_pending_approval: has_pending,
                files_changed: stats.map(|s| s.files_changed),
                lines_added: stats.map(|s| s.lines_added),
                lines_removed: stats.map(|s| s.lines_removed),
                latest_process_completed_at: latest.and_then(|p| p.completed_at),
                latest_process_status: latest.map(|p| p.status.clone()),
                has_running_dev_server: dev_server_workspaces.contains(&id),
                has_unseen_turns: unseen_workspaces.contains(&id),
                pr_status: pr_statuses.get(&id).map(|pr| pr.pr_status.clone()),
                pr_number: pr_statuses.get(&id).map(|pr| pr.pr_number),
                pr_url: pr_statuses.get(&id).map(|pr| pr.pr_url.clone()),
                pr_mergeable: pr_statuses.get(&id).and_then(|pr| pr.pr_mergeable.clone()),
                latest_context_usage: context_usage.get(&id).cloned(),
                latest_process_started_at: coding_agent_processes
                    .get(&id)
                    .map(|info| info.started_at),
            }
        })
        .collect();

    Ok(ResponseJson(ApiResponse::success(
        WorkspaceSummaryResponse { summaries },
    )))
}

/// Cache of context usage for *finished* execution processes: their logs are
/// immutable, so the (expensive) re-normalization below only runs once per
/// execution for the lifetime of the server process.
static FINISHED_USAGE_CACHE: LazyLock<Mutex<HashMap<Uuid, Option<TokenUsageInfo>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Find the most recent token-usage entry of an execution process.
///
/// Normalized entries only exist in memory: the persisted raw logs contain
/// `Stdout`/`Stderr` lines exclusively (`spawn_stream_raw_logs_to_storage`
/// skips `JsonPatch` messages). So for a running process we scan its live
/// `MsgStore` history, and for a finished one we re-normalize the persisted
/// raw logs via `stream_normalized_logs` (cached, see above).
async fn find_latest_context_usage(
    deployment: &DeploymentImpl,
    execution_id: Uuid,
) -> Option<TokenUsageInfo> {
    if let Some(store) = deployment
        .container()
        .get_msg_store_by_id(&execution_id)
        .await
    {
        return store.find_map_history_rev(token_usage_from_log_msg);
    }

    if let Some(cached) = FINISHED_USAGE_CACHE.lock().unwrap().get(&execution_id) {
        return cached.clone();
    }

    let mut result = None;
    if let Some(stream) = deployment
        .container()
        .stream_normalized_logs(&execution_id)
        .await
    {
        // The stream terminates with `LogMsg::Finished` for stopped processes.
        let msgs: Vec<_> = stream.collect().await;
        result = msgs
            .iter()
            .rev()
            .filter_map(|m| m.as_ref().ok())
            .find_map(token_usage_from_log_msg);
    }

    FINISHED_USAGE_CACHE
        .lock()
        .unwrap()
        .insert(execution_id, result.clone());
    result
}

/// Extract a token-usage entry from a normalized `JsonPatch` message. Op
/// values are `NormalizedEntry` objects; the internally-tagged `entry_type`
/// carries the usage
/// (`{"type":"token_usage_info","total_tokens":..,"model_context_window":..}`).
fn token_usage_from_log_msg(msg: &LogMsg) -> Option<TokenUsageInfo> {
    let LogMsg::JsonPatch(patch) = msg else {
        return None;
    };
    let ops = serde_json::to_value(patch).ok()?;
    let ops = ops.as_array()?;
    for op in ops.iter().rev() {
        let Some(entry_type) = op.get("value").and_then(|v| v.get("entry_type")) else {
            continue;
        };
        if entry_type.get("type").and_then(|t| t.as_str()) != Some("token_usage_info") {
            continue;
        }
        if let Ok(info) = serde_json::from_value::<TokenUsageInfo>(entry_type.clone()) {
            return Some(info);
        }
    }
    None
}

/// Compute diff stats for a workspace.
pub async fn compute_workspace_diff_stats(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
) -> Option<DiffStats> {
    let stats = services::services::diff_stream::compute_diff_stats(
        &deployment.db().pool,
        deployment.git(),
        workspace,
    )
    .await?;

    Some(DiffStats {
        files_changed: stats.files_changed,
        lines_added: stats.lines_added,
        lines_removed: stats.lines_removed,
    })
}
