//! Aggregate productivity data for the dashboard impact chart.

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

/// Upper bound on rows returned by `closed-issues`. Generous enough that a real
/// 90-day window is never truncated, low enough to stay a bounded response.
const CLOSED_ISSUES_LIMIT: i64 = 2000;

/// Widest window the endpoint will serve, in days.
const MAX_WINDOW_DAYS: i64 = 365;

/// Default window when the caller omits `days`.
const DEFAULT_WINDOW_DAYS: i64 = 30;

/// A single closed issue, across every repo.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct ClosedIssue {
    pub repo_id: Uuid,
    #[ts(type = "number")]
    pub number: i64,
    pub title: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub closed_at: String,
}

#[derive(Debug, Serialize, TS)]
pub struct ClosedIssuesResponse {
    pub issues: Vec<ClosedIssue>,
}

#[derive(Debug, Deserialize)]
pub struct ClosedIssuesQuery {
    /// Window size in days, counting back from now. Defaults to 30.
    pub days: Option<i64>,
}

/// Issues closed within the last `days` days, newest first.
///
/// Deliberately returns the raw rows instead of a `GROUP BY date(closed_at)`
/// rollup: SQL would bucket by UTC day, but the chart's x-axis is the viewer's
/// local calendar. At UTC-3 an issue closed 21:00 local lands on the next UTC
/// day, so the grouping has to happen client-side. Handing back the rows also
/// lets the tooltip name the issues behind each point.
///
/// Uses a runtime-checked query so the committed sqlx offline metadata for the
/// macro queries stays valid (same reasoning as `list_completed_worker_tasks`).
pub async fn list_closed_issues(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ClosedIssuesQuery>,
) -> Result<ResponseJson<ApiResponse<ClosedIssuesResponse>>, ApiError> {
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

    let issues: Vec<ClosedIssue> = sqlx::query_as(
        "SELECT repo_id, number, title, closed_at
         FROM repo_issues
         WHERE closed_at IS NOT NULL AND closed_at >= datetime('now', $1)
         ORDER BY closed_at DESC
         LIMIT $2",
    )
    .bind(since_modifier)
    .bind(CLOSED_ISSUES_LIMIT)
    .fetch_all(&deployment.db().pool)
    .await?;

    Ok(ResponseJson(ApiResponse::success(ClosedIssuesResponse {
        issues,
    })))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/impact/closed-issues", get(list_closed_issues))
}
