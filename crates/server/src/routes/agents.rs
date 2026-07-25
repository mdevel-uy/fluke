use std::{
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use db::models::execution_process::ExecutionProcess;
use deployment::Deployment;
use executors::{
    executors::{BaseCodingAgent, claude::rate_limit_info_from_log_line},
    logs::RateLimitInfo,
};
use futures_util::StreamExt;
use serde::Serialize;
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::{log_msg::LogMsg, response::ApiResponse};

use crate::{DeploymentImpl, error::ApiError};

/// One plan-usage window: session (5h), weekly across models, weekly Opus.
#[derive(Debug, Clone, Serialize, TS)]
pub struct ClaudeUsageMeter {
    /// `session`, `week_all`, `week_opus`, or whatever Claude called it.
    pub key: String,
    /// 0-100.
    pub used_percent: f32,
    /// RFC3339, when Claude reported a reset time.
    pub resets_at: Option<String>,
}

/// Account-level Claude plan limits. Global, not per worker.
#[derive(Debug, Clone, Serialize, TS)]
pub struct ClaudeUsageResponse {
    /// Raw plan name as reported by Claude Code; never translated.
    pub plan: Option<String>,
    pub meters: Vec<ClaudeUsageMeter>,
    /// Workers whose active workspace runs Claude Code.
    pub workers_on_claude: i64,
}

/// Limits change slowly and mining them re-reads agent logs, so the answer is
/// cached for a little under the frontend's polling interval.
const CACHE_TTL: Duration = Duration::from_secs(45);

/// Only the most recent coding-agent runs are scanned: limits are account-wide,
/// so the newest report wins and older logs cannot improve the answer.
const MAX_PROCESSES_SCANNED: usize = 5;

static USAGE_CACHE: LazyLock<Mutex<Option<(Instant, Option<ClaudeUsageResponse>)>>> =
    LazyLock::new(|| Mutex::new(None));

fn cached() -> Option<Option<ClaudeUsageResponse>> {
    let guard = USAGE_CACHE.lock().unwrap();
    let (stamped, value) = guard.as_ref()?;
    (stamped.elapsed() < CACHE_TTL).then(|| value.clone())
}

/// Newest `rate_limit_event` payload in an execution's raw agent logs.
async fn latest_rate_limit_for_process(
    deployment: &DeploymentImpl,
    execution_id: uuid::Uuid,
) -> Option<RateLimitInfo> {
    let stream = deployment.container().stream_raw_logs(&execution_id).await?;
    let msgs: Vec<_> = stream.collect().await;
    msgs.iter()
        .rev()
        .filter_map(|msg| match msg {
            Ok(LogMsg::Stdout(chunk)) => Some(chunk),
            _ => None,
        })
        .find_map(|chunk| chunk.lines().rev().find_map(rate_limit_info_from_log_line))
}

async fn get_claude_usage(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Option<ClaudeUsageResponse>>>, ApiError> {
    if let Some(hit) = cached() {
        return Ok(ResponseJson(ApiResponse::success(hit)));
    }

    let pool = &deployment.db().pool;

    let workers_on_claude: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT w.worker_id)
           FROM workspaces w
           JOIN sessions s ON s.workspace_id = w.id
           WHERE w.archived = FALSE
             AND w.worker_id IS NOT NULL
             AND s.executor = ?"#,
    )
    .bind(BaseCodingAgent::ClaudeCode.to_string())
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let mut processes: Vec<_> =
        ExecutionProcess::find_latest_coding_agent_for_workspaces(pool, false)
            .await?
            .into_values()
            .collect();
    processes.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    processes.truncate(MAX_PROCESSES_SCANNED);

    let mut info = None;
    for process in processes {
        if let Some(found) =
            latest_rate_limit_for_process(&deployment, process.execution_process_id).await
        {
            info = Some(found);
            break;
        }
    }

    let response = info.map(|info| ClaudeUsageResponse {
        plan: info.plan,
        meters: info
            .windows
            .into_iter()
            .map(|window| ClaudeUsageMeter {
                key: window.key,
                used_percent: window.used_percent,
                resets_at: window.resets_at,
            })
            .collect(),
        workers_on_claude,
    });

    *USAGE_CACHE.lock().unwrap() = Some((Instant::now(), response.clone()));
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/agents/claude/usage", get(get_claude_usage))
}
