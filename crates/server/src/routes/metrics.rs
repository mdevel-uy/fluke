//! Plan cap-hit + fleet health metrics.
//!
//! Two related endpoints:
//! * `GET /api/metrics` — Prometheus text exposition consumed by the local
//!   Alloy sidecar (see `ops/alloy/config.alloy`), which forwards to the
//!   central Prometheus via `remote_write`. Exposes: build/version info,
//!   worker tasks per status, running coding agents, executor failure
//!   counters, plan cap-hit counters, and the configured concurrency cap.
//! * `GET /api/plan-limits` — JSON: the concurrent-agents limit, the
//!   configured upsell CTA (if any), and today's cap-hit count. The
//!   Workers/Sprint UI reads this so the toast that fires on a cap-hit can
//!   name the limit and link to the upsell page.

use axum::{
    Router,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::get,
};
use db::models::{
    execution_process::ExecutionProcess, plan_cap_hit::PlanCapHit, worker_task::WorkerTask,
};
use deployment::Deployment;
use serde::Serialize;
use services::services::worker_orchestrator;
use ts_rs::TS;
use utils::{response::ApiResponse, version::APP_VERSION};

use crate::{DeploymentImpl, error::ApiError};

const PLAN_UPGRADE_CTA_URL_ENV: &str = "PLAN_UPGRADE_CTA_URL";
const PLAN_UPGRADE_CTA_LABEL_ENV: &str = "PLAN_UPGRADE_CTA_LABEL";

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/metrics", get(get_metrics))
        .route("/plan-limits", get(get_plan_limits))
}

/// Upsell CTA surfaced by the frontend when a task is queued because the
/// concurrent-agents cap is full. Both fields must be non-empty for the
/// CTA to be exposed; ops set them via env vars so they can be swapped
/// (mailto, pricing page, etc.) without a deploy.
#[derive(Debug, Serialize, TS)]
pub struct PlanUpgradeCta {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Serialize, TS)]
pub struct PlanLimitsResponse {
    /// Maximum concurrent in-review agents allowed per worker; the value
    /// [`worker_orchestrator::max_in_review_from_env`] enforces.
    pub concurrent_agents_limit: i64,
    /// null when the deployment has not configured an upsell CTA.
    pub upgrade_cta: Option<PlanUpgradeCta>,
    pub cap_hits_today: i64,
    pub cap_hits_total: i64,
}

fn read_cta_from_env() -> Option<PlanUpgradeCta> {
    let url = std::env::var(PLAN_UPGRADE_CTA_URL_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let label = std::env::var(PLAN_UPGRADE_CTA_LABEL_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Upgrade plan".to_string());
    Some(PlanUpgradeCta { label, url })
}

async fn get_plan_limits(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<PlanLimitsResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let cap_hits_today = PlanCapHit::count_today(pool).await?;
    let cap_hits_total = PlanCapHit::total_count(pool).await?;

    Ok(ResponseJson(ApiResponse::success(PlanLimitsResponse {
        concurrent_agents_limit: worker_orchestrator::max_in_review_from_env(),
        upgrade_cta: read_cta_from_env(),
        cap_hits_today,
        cap_hits_total,
    })))
}

async fn get_metrics(State(deployment): State<DeploymentImpl>) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;
    let total = PlanCapHit::total_count(pool).await?;
    let cap = worker_orchestrator::max_in_review_from_env();
    let rows = PlanCapHit::list_all(pool).await?;
    let task_counts = WorkerTask::counts_by_status(pool).await?;
    let running_agents = ExecutionProcess::count_running_coding_agents(pool).await?;
    let failed_by_reason = ExecutionProcess::counts_failed_by_run_reason(pool).await?;

    let mut body = String::new();

    // Build info — standard Prometheus pattern: gauge = 1 with the version
    // in a label so PromQL joins (`* on (instance) group_left vibe_kanban_build_info`)
    // pin queries to a specific release.
    body.push_str(
        "# HELP vibe_kanban_build_info Build metadata for this instance; \
         always 1, version carried in the label.\n",
    );
    body.push_str("# TYPE vibe_kanban_build_info gauge\n");
    body.push_str(&format!(
        "vibe_kanban_build_info{{version=\"{}\"}} 1\n",
        escape_label(APP_VERSION),
    ));

    // Worker tasks by status. Emitted for every valid status even at 0 so
    // Grafana panels do not flicker between "no data" and a number.
    body.push_str(
        "# HELP vibe_kanban_worker_tasks Current count of worker tasks by status.\n",
    );
    body.push_str("# TYPE vibe_kanban_worker_tasks gauge\n");
    for (status, count) in &task_counts {
        body.push_str(&format!(
            "vibe_kanban_worker_tasks{{status=\"{}\"}} {}\n",
            escape_label(status),
            count,
        ));
    }

    body.push_str(
        "# HELP vibe_kanban_agents_running Number of coding-agent processes \
         currently in the `running` state.\n",
    );
    body.push_str("# TYPE vibe_kanban_agents_running gauge\n");
    body.push_str(&format!(
        "vibe_kanban_agents_running {}\n",
        running_agents,
    ));

    // Cumulative counter of failed executor processes per run_reason.
    // Always emit the metric name so alerts on `rate(...)` don't disappear
    // when no failures have been recorded yet.
    body.push_str(
        "# HELP vibe_kanban_execution_processes_failed_total Cumulative \
         count of execution processes that ended in the `failed` state, \
         partitioned by run_reason.\n",
    );
    body.push_str("# TYPE vibe_kanban_execution_processes_failed_total counter\n");
    if failed_by_reason.is_empty() {
        body.push_str("vibe_kanban_execution_processes_failed_total 0\n");
    } else {
        for (reason, count) in &failed_by_reason {
            body.push_str(&format!(
                "vibe_kanban_execution_processes_failed_total{{run_reason=\"{}\"}} {}\n",
                escape_label(reason),
                count,
            ));
        }
    }

    body.push_str("# HELP plan_cap_hits_total Total number of times a worker start was refused because the concurrent-agents cap was reached.\n");
    body.push_str("# TYPE plan_cap_hits_total counter\n");
    body.push_str(&format!("plan_cap_hits_total {}\n", total));

    body.push_str("# HELP plan_cap_hits_by_date Count of plan cap-hit events per UTC calendar day.\n");
    body.push_str("# TYPE plan_cap_hits_by_date gauge\n");
    for row in &rows {
        body.push_str(&format!(
            "plan_cap_hits_by_date{{date=\"{}\"}} {}\n",
            row.date, row.count
        ));
    }

    body.push_str("# HELP plan_concurrent_agents_limit Current concurrent-agents cap (WORKER_MAX_IN_REVIEW).\n");
    body.push_str("# TYPE plan_concurrent_agents_limit gauge\n");
    body.push_str(&format!("plan_concurrent_agents_limit {}\n", cap));

    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response())
}

/// Escape backslash, double-quote and newline in a Prometheus label value.
/// Applied to every dynamic value we splice into the text exposition so a
/// stray character (e.g. a version suffix containing `"`) cannot corrupt the
/// output.
fn escape_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape_label;

    #[test]
    fn escape_label_passes_plain_ascii_through() {
        assert_eq!(escape_label("0.1.44"), "0.1.44");
        assert_eq!(escape_label("in_progress"), "in_progress");
    }

    #[test]
    fn escape_label_escapes_prometheus_specials() {
        assert_eq!(escape_label("a\"b"), "a\\\"b");
        assert_eq!(escape_label("a\\b"), "a\\\\b");
        assert_eq!(escape_label("a\nb"), "a\\nb");
    }
}
