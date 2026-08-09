use axum::{
    Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::Serialize;
use services::services::base_instructions;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/system/base-instructions", get(get_base_instructions))
        .route("/system/pr-poll", post(trigger_pr_poll))
}

/// Wake the pr_monitor for an immediate full cycle (CI gate, review dispatch,
/// PR adoption) instead of waiting out the 60s interval. Fire-and-forget: the
/// cycle runs in the monitor's own task; results land in the DB and reach the
/// UI through the usual summary queries.
async fn trigger_pr_poll(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<()>> {
    deployment.trigger_pr_poll();
    ResponseJson(ApiResponse::success(()))
}

#[derive(Debug, Serialize, TS)]
pub struct BaseInstructionsResponse {
    pub content: String,
}

async fn get_base_instructions() -> ResponseJson<ApiResponse<BaseInstructionsResponse>> {
    ResponseJson(ApiResponse::success(BaseInstructionsResponse {
        content: base_instructions::effective_base_instructions(),
    }))
}
