//! Aggregate the "value generated" that anchors our pricing conversation:
//! how many worker tasks reached `done` in each month, and the man-hours those
//! tasks represent.
//!
//! The endpoint returns raw monthly buckets (done count + summed per-task
//! overrides + count of tasks with an override) rather than the final hours /
//! FTE figures. Reasoning: the "default hours per task" is a viewer setting
//! kept in the browser (see `useValueGeneratedSettingsStore`); pushing the
//! multiplication client-side lets a viewer tweak that factor and see numbers
//! move without a round-trip.

use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use chrono::Utc;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// Default number of trailing months returned when the caller omits `months`.
/// Twelve keeps the panel useful for a rolling-year narrative without turning
/// into an unbounded history dump.
const DEFAULT_HISTORY_MONTHS: i64 = 12;

/// Upper bound on history depth. Two years is generous for the pricing story
/// and still cheap to aggregate in SQLite.
const MAX_HISTORY_MONTHS: i64 = 24;

/// One month of value generation, keyed by calendar month in UTC. The frontend
/// bucketizes into local time only when it renders the chip labels; grouping
/// by UTC month here keeps the aggregation deterministic across timezones.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct ValueGeneratedMonth {
    /// Month key in `YYYY-MM` form (UTC).
    pub year_month: String,
    /// Worker tasks that reached `done` inside this month.
    #[ts(type = "number")]
    pub done_count: i64,
    /// Worker tasks in `done_count` that carry a per-task override.
    #[ts(type = "number")]
    pub tasks_with_override: i64,
    /// Sum of `hours_saved_override` across the tasks in `tasks_with_override`.
    /// Zero when none of the month's tasks carry an override.
    pub override_hours_sum: f64,
    /// Worker tasks in `done_count` that have any recorded LLM usage. Used by
    /// the panel to flag partial coverage — when `tasks_with_cost < done_count`
    /// the cost figure is a lower bound (agents like Codex/OpenCode may not
    /// report USD until pricing tables are wired up).
    #[ts(type = "number")]
    pub tasks_with_cost: i64,
    /// Sum of `cost_usd_total` across the tasks in `tasks_with_cost`. Zero when
    /// no task in the bucket recorded API cost.
    pub cost_usd_sum: f64,
    /// Sum of `input_tokens_total`. Zero when no task recorded tokens.
    #[ts(type = "number")]
    pub input_tokens_sum: i64,
    /// Sum of `output_tokens_total`. Zero when no task recorded tokens.
    #[ts(type = "number")]
    pub output_tokens_sum: i64,
    /// Sum of `cache_creation_tokens_total`. Zero when unrecorded.
    #[ts(type = "number")]
    pub cache_creation_tokens_sum: i64,
    /// Sum of `cache_read_tokens_total`. Zero when unrecorded.
    #[ts(type = "number")]
    pub cache_read_tokens_sum: i64,
}

#[derive(Debug, Serialize, TS)]
pub struct ValueGeneratedSummaryResponse {
    /// Newest month first. Includes the current month even when it has zero
    /// completed tasks so the panel can render a "0" today without special-
    /// casing an empty response.
    pub months: Vec<ValueGeneratedMonth>,
}

#[derive(Debug, Deserialize)]
pub struct ValueGeneratedQuery {
    /// Number of trailing calendar months to include, inclusive of the current
    /// month. Defaults to twelve; capped at `MAX_HISTORY_MONTHS`.
    pub months: Option<i64>,
}

/// Monthly summary of tasks completed and their contributed value overrides.
///
/// Runtime-checked query to keep the committed sqlx offline metadata for the
/// macro queries stable (same reasoning as `list_completed_worker_tasks`).
pub async fn value_generated_summary(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ValueGeneratedQuery>,
) -> Result<ResponseJson<ApiResponse<ValueGeneratedSummaryResponse>>, ApiError> {
    let requested = query.months.unwrap_or(DEFAULT_HISTORY_MONTHS);
    if !(1..=MAX_HISTORY_MONTHS).contains(&requested) {
        return Err(ApiError::BadRequest(format!(
            "months must be between 1 and {MAX_HISTORY_MONTHS}"
        )));
    }

    // Start of the earliest month we care about. `start of month` normalises to
    // midnight on the 1st, so tasks completed anywhere inside that first month
    // are still included.
    let months_back = format!("-{} months", requested - 1);

    let rows: Vec<ValueGeneratedMonth> = sqlx::query_as(
        "SELECT strftime('%Y-%m', completed_at) AS year_month,
                COUNT(*)                        AS done_count,
                SUM(CASE WHEN hours_saved_override IS NOT NULL THEN 1 ELSE 0 END)
                                                AS tasks_with_override,
                COALESCE(SUM(hours_saved_override), 0.0)
                                                AS override_hours_sum,
                SUM(CASE WHEN cost_usd_total IS NOT NULL THEN 1 ELSE 0 END)
                                                AS tasks_with_cost,
                COALESCE(SUM(cost_usd_total), 0.0)
                                                AS cost_usd_sum,
                COALESCE(SUM(input_tokens_total), 0)
                                                AS input_tokens_sum,
                COALESCE(SUM(output_tokens_total), 0)
                                                AS output_tokens_sum,
                COALESCE(SUM(cache_creation_tokens_total), 0)
                                                AS cache_creation_tokens_sum,
                COALESCE(SUM(cache_read_tokens_total), 0)
                                                AS cache_read_tokens_sum
         FROM worker_tasks
         WHERE status = 'done'
           AND completed_at IS NOT NULL
           AND completed_at >= datetime('now', 'start of month', $1)
         GROUP BY year_month
         ORDER BY year_month DESC",
    )
    .bind(&months_back)
    .fetch_all(&deployment.db().pool)
    .await?;

    // Ensure the current month is always in the response even when no tasks
    // were completed yet: otherwise the panel would fall back to the previous
    // month, which is confusing on the 1st.
    let months = fill_current_month(rows);

    Ok(ResponseJson(ApiResponse::success(
        ValueGeneratedSummaryResponse { months },
    )))
}

/// If the newest returned row is not the current UTC month, prepend a zero
/// bucket for it. The frontend depends on `months[0]` being "now".
fn fill_current_month(mut months: Vec<ValueGeneratedMonth>) -> Vec<ValueGeneratedMonth> {
    let current = Utc::now().format("%Y-%m").to_string();
    if months.first().map(|m| m.year_month.as_str()) != Some(current.as_str()) {
        months.insert(
            0,
            ValueGeneratedMonth {
                year_month: current,
                done_count: 0,
                tasks_with_override: 0,
                override_hours_sum: 0.0,
                tasks_with_cost: 0,
                cost_usd_sum: 0.0,
                input_tokens_sum: 0,
                output_tokens_sum: 0,
                cache_creation_tokens_sum: 0,
                cache_read_tokens_sum: 0,
            },
        );
    }
    months
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/value-generated/summary", get(value_generated_summary))
}
