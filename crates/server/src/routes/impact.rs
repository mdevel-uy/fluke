//! Aggregate productivity data for the dashboard impact chart.
//!
//! The chart counts worker tasks that reached `done` — the same population the
//! value-generated panel bills against — rather than GitHub issue closures.
//! Issue closures include administrative events (duplicates, bulk cleanups,
//! not-planned) that represent no delivered work, so charting them alongside a
//! "hours saved" figure overstated impact and contradicted the monthly panel.

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

/// Upper bound on rows returned by `resolved-tasks`. Generous enough that a
/// real 90-day window is never truncated, low enough to stay a bounded
/// response.
const RESOLVED_TASKS_LIMIT: i64 = 2000;

/// Widest window the endpoint will serve, in days.
const MAX_WINDOW_DAYS: i64 = 365;

/// Default window when the caller omits `days`.
const DEFAULT_WINDOW_DAYS: i64 = 30;

/// A single worker task that reached `done`, across every repo.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct ResolvedTask {
    pub repo_id: Uuid,
    /// GitHub issue the task was spawned from, when there is one.
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub title: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub completed_at: String,
}

#[derive(Debug, Serialize, TS)]
pub struct ResolvedTasksResponse {
    pub tasks: Vec<ResolvedTask>,
}

#[derive(Debug, Deserialize)]
pub struct ResolvedTasksQuery {
    /// Window size in days, counting back from now. Defaults to 30.
    pub days: Option<i64>,
}

/// Worker tasks completed within the last `days` days, newest first.
///
/// Deliberately returns the raw rows instead of a `GROUP BY date(completed_at)`
/// rollup: SQL would bucket by UTC day, but the chart's x-axis is the viewer's
/// local calendar. At UTC-3 a task completed 21:00 local lands on the next UTC
/// day, so the grouping has to happen client-side. Handing back the rows also
/// lets the tooltip name the tasks behind each point.
///
/// The `status = 'done' AND completed_at IS NOT NULL` filter matches the
/// value-generated summary exactly, so the two panels always agree on what
/// counts as resolved work.
///
/// Uses a runtime-checked query so the committed sqlx offline metadata for the
/// macro queries stays valid (same reasoning as `list_completed_worker_tasks`).
pub async fn list_resolved_tasks(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ResolvedTasksQuery>,
) -> Result<ResponseJson<ApiResponse<ResolvedTasksResponse>>, ApiError> {
    let days = query.days.unwrap_or(DEFAULT_WINDOW_DAYS);
    if !(1..=MAX_WINDOW_DAYS).contains(&days) {
        return Err(ApiError::BadRequest(format!(
            "days must be between 1 and {MAX_WINDOW_DAYS}"
        )));
    }

    // One extra day of slack so the client's local-day bucketing always has the
    // full boundary day available, whatever the viewer's timezone. The bound is
    // computed by SQLite rather than bound as a timestamp so both sides of the
    // comparison are in SQLite's own textual datetime format.
    let since_modifier = format!("-{} days", days + 1);

    let tasks: Vec<ResolvedTask> = sqlx::query_as(
        "SELECT repo_id, issue_number, title, completed_at
         FROM worker_tasks
         WHERE status = 'done'
           AND completed_at IS NOT NULL
           AND completed_at >= datetime('now', $1)
         ORDER BY completed_at DESC
         LIMIT $2",
    )
    .bind(since_modifier)
    .bind(RESOLVED_TASKS_LIMIT)
    .fetch_all(&deployment.db().pool)
    .await?;

    Ok(ResponseJson(ApiResponse::success(ResolvedTasksResponse {
        tasks,
    })))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/impact/resolved-tasks", get(list_resolved_tasks))
}
