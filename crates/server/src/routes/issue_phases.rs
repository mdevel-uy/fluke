//! Plan de fases del issue (fluke v2, F3, #686): read-only view of an
//! issue's life cycle, derived by `services::issue_phases`.

use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::get,
};
use db::models::repo_issue::RepoIssue;
use deployment::Deployment;
use services::services::issue_phases::{self, IssuePlanResponse};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route(
        "/repos/{repo_id}/issues/{issue_number}/phases",
        get(get_issue_phases),
    )
}

async fn get_issue_phases(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
) -> Result<ResponseJson<ApiResponse<IssuePlanResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let issue_closed = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number)
        .await?
        .is_some_and(|i| i.state != "open");
    let plan = issue_phases::load_issue_plan(pool, repo_id, issue_number, issue_closed).await?;
    Ok(ResponseJson(ApiResponse::success(plan)))
}
