use axum::{Router, response::Json as ResponseJson, routing::get};
use serde::Serialize;
use services::services::base_instructions;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/system/base-instructions", get(get_base_instructions))
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
