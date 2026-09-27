//! Pilot report: exportable numbers for the client's management.
//!
//! Aggregates the raw signals a pilot is judged on — worker tasks that
//! reached a terminal status and PRs that landed — over an arbitrary
//! date range. The endpoint returns the underlying rows; the frontend
//! converts them into KPIs (tickets resolved, PRs merged, hours saved,
//! FTE equivalent, USD value) using tunable assumptions the viewer can
//! adjust inline before printing or exporting.

use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Upper bound on individual rows in each list, so a huge window can't
/// produce an unbounded response. Chosen so a full 12-month pilot with
/// generous throughput still fits without truncation.
const PILOT_REPORT_ROW_LIMIT: i64 = 5000;

/// Widest window the endpoint will serve, in days. A pilot lasts one
/// month; the ceiling gives room for after-the-fact reporting.
const MAX_WINDOW_DAYS: i64 = 400;

/// A worker task that reached a terminal status inside the window.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct PilotReportTask {
    pub worker_id: Uuid,
    pub title: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    /// "done" | "failed"
    pub status: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub completed_at: String,
    /// Per-task hours-saved override, when the viewer pinned an explicit
    /// figure on the value-generated panel. `None` means "use the
    /// installation default" (`Config.default_hours_saved_per_task`).
    /// Kept aligned with the value-generated panel formula so both surfaces
    /// tell the same story for the same month.
    #[ts(type = "number | null")]
    pub hours_saved_override: Option<f64>,
    /// Rolled-up LLM cost across every execution that ran under this task.
    /// `None` when the task never had any usage recorded (older tasks,
    /// executors that don't emit `total_cost_usd` yet). Kept nullable so the
    /// frontend can flag partial coverage ("≥") instead of inventing zeros.
    pub cost_usd: Option<f64>,
    #[ts(type = "number | null")]
    pub input_tokens: Option<i64>,
    #[ts(type = "number | null")]
    pub output_tokens: Option<i64>,
    #[ts(type = "number | null")]
    pub cache_creation_tokens: Option<i64>,
    #[ts(type = "number | null")]
    pub cache_read_tokens: Option<i64>,
}

/// A pull request merged inside the window.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct PilotReportMergedPr {
    #[ts(type = "number")]
    pub pr_number: i64,
    pub pr_url: String,
    pub target_branch_name: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub merged_at: String,
}

#[derive(Debug, Serialize, TS)]
pub struct PilotReportResponse {
    /// Lower bound (inclusive) that was actually queried, echoed back so
    /// the client can render the window it received rather than the one
    /// it asked for (they can drift when the query is clamped).
    pub from: String,
    /// Upper bound (exclusive) that was actually queried.
    pub to: String,
    pub completed_tasks: Vec<PilotReportTask>,
    pub merged_prs: Vec<PilotReportMergedPr>,
}

/// Query params: an ISO-8601 / RFC-3339 half-open interval `[from, to)`.
/// Both are required — the client always knows the window it wants to
/// report on, and defaulting silently would hide a bug at the boundary.
#[derive(Debug, Deserialize)]
pub struct PilotReportQuery {
    pub from: String,
    pub to: String,
}

/// Worker tasks completed and PRs merged inside `[from, to)`.
///
/// Written as runtime-checked queries (like `list_completed_worker_tasks`
/// and `list_resolved_tasks`) so the committed sqlx offline metadata for
/// the macro queries stays valid.
pub async fn get_pilot_report(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<PilotReportQuery>,
) -> Result<ResponseJson<ApiResponse<PilotReportResponse>>, ApiError> {
    // Parse RFC-3339 to get a real Duration for the guard. We hand the
    // strings straight to SQLite — its `datetime()` accepts them — but the
    // parse still runs so we can reject nonsense before hitting the DB.
    let from = chrono::DateTime::parse_from_rfc3339(&query.from)
        .map_err(|e| ApiError::BadRequest(format!("invalid `from`: {e}")))?
        .with_timezone(&chrono::Utc);
    let to = chrono::DateTime::parse_from_rfc3339(&query.to)
        .map_err(|e| ApiError::BadRequest(format!("invalid `to`: {e}")))?
        .with_timezone(&chrono::Utc);

    if to <= from {
        return Err(ApiError::BadRequest("`to` must be after `from`".into()));
    }
    let window_days = (to - from).num_days().max(1);
    if window_days > MAX_WINDOW_DAYS {
        return Err(ApiError::BadRequest(format!(
            "window must be at most {MAX_WINDOW_DAYS} days"
        )));
    }

    let from_sql = from.format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let to_sql = to.format("%Y-%m-%d %H:%M:%S%.3f").to_string();

    let completed_tasks: Vec<PilotReportTask> = sqlx::query_as(
        "SELECT worker_id, title, issue_number, status, completed_at,
                hours_saved_override,
                cost_usd_total              AS cost_usd,
                input_tokens_total          AS input_tokens,
                output_tokens_total         AS output_tokens,
                cache_creation_tokens_total AS cache_creation_tokens,
                cache_read_tokens_total     AS cache_read_tokens
         FROM worker_tasks
         WHERE completed_at IS NOT NULL
           AND completed_at >= datetime($1)
           AND completed_at <  datetime($2)
         ORDER BY completed_at DESC
         LIMIT $3",
    )
    .bind(&from_sql)
    .bind(&to_sql)
    .bind(PILOT_REPORT_ROW_LIMIT)
    .fetch_all(&deployment.db().pool)
    .await?;

    let merged_prs: Vec<PilotReportMergedPr> = sqlx::query_as(
        "SELECT pr_number, pr_url, target_branch_name, merged_at
         FROM pull_requests
         WHERE pr_status = 'merged'
           AND merged_at IS NOT NULL
           AND merged_at >= datetime($1)
           AND merged_at <  datetime($2)
         ORDER BY merged_at DESC
         LIMIT $3",
    )
    .bind(&from_sql)
    .bind(&to_sql)
    .bind(PILOT_REPORT_ROW_LIMIT)
    .fetch_all(&deployment.db().pool)
    .await?;

    Ok(ResponseJson(ApiResponse::success(PilotReportResponse {
        from: from.to_rfc3339(),
        to: to.to_rfc3339(),
        completed_tasks,
        merged_prs,
    })))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/pilot-report", get(get_pilot_report))
}
