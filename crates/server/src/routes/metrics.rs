//! Plan cap-hit metrics.
//!
//! Two related endpoints:
//! * `GET /api/metrics` — Prometheus text exposition; ventas / ops scrape it
//!   to size upgrade conversations.
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
use db::models::plan_cap_hit::PlanCapHit;
use deployment::Deployment;
use serde::Serialize;
use services::services::worker_orchestrator;
use ts_rs::TS;
use utils::response::ApiResponse;

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

    let mut body = String::new();
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
