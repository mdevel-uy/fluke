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
use services::services::{
    issue_phases::{self, IssueBlockerEntry, IssuePlanResponse},
    stuck_task_detector, worker_orchestrator,
};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/repos/{repo_id}/issues/{issue_number}/phases",
            get(get_issue_phases),
        )
        .route("/repos/{repo_id}/issues/blockers", get(get_issue_blockers))
}

async fn get_issue_phases(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
) -> Result<ResponseJson<ApiResponse<IssuePlanResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let issue = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number).await?;
    let issue_closed = issue.as_ref().is_some_and(|i| i.state != "open");
    let plan = issue_phases::load_issue_plan(
        pool,
        repo_id,
        issue_number,
        issue_closed,
        issue.as_ref().and_then(|i| i.body.as_deref()),
        max_rounds(&deployment).await,
        stuck_task_detector::threshold_minutes(),
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(plan)))
}

async fn max_rounds(deployment: &DeploymentImpl) -> i64 {
    worker_orchestrator::resolve_max_review_rounds(&*deployment.config().read().await)
}

async fn get_issue_blockers(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<IssueBlockerEntry>>>, ApiError> {
    let list = issue_phases::list_blockers(
        &deployment.db().pool,
        repo_id,
        max_rounds(&deployment).await,
        stuck_task_detector::threshold_minutes(),
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(list)))
}
