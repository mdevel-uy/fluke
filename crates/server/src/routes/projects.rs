use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::project_issue::ProjectIssue;
use deployment::Deployment;
use serde::Serialize;
use services::services::project_issues::{ProjectIssuesError, ProjectIssuesService};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Serialize, TS)]
pub struct ProjectIssuesSyncResult {
    pub synced: usize,
}

pub async fn list_project_issues(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<ProjectIssue>>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let issues = ProjectIssuesService::new().list(&pool, project_id).await?;

    // On project open, kick off a background refresh so the list stays
    // fresh without blocking the request. Errors are logged only.
    let git = deployment.git().clone();
    tokio::spawn(async move {
        if let Err(err) = ProjectIssuesService::new()
            .sync(&pool, &git, project_id)
            .await
        {
            tracing::debug!(
                project_id = %project_id,
                "background project issues sync failed: {}",
                err
            );
        }
    });

    Ok(ResponseJson(ApiResponse::success(issues)))
}

pub async fn sync_project_issues(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ProjectIssuesSyncResult>>, ApiError> {
    let outcome = ProjectIssuesService::new()
        .sync(&deployment.db().pool, deployment.git(), project_id)
        .await?;

    Ok(ResponseJson(ApiResponse::success(
        ProjectIssuesSyncResult {
            synced: outcome.synced,
        },
    )))
}

impl From<ProjectIssuesError> for ApiError {
    fn from(err: ProjectIssuesError) -> Self {
        match err {
            ProjectIssuesError::Sqlx(e) => ApiError::Database(e),
            ProjectIssuesError::Io(e) => ApiError::Io(e),
            ProjectIssuesError::Json(e) => {
                ApiError::BadGateway(format!("Failed to parse gh output: {e}"))
            }
            ProjectIssuesError::ProjectNotFound => {
                ApiError::BadRequest("Project not found".to_string())
            }
            ProjectIssuesError::NoGithubRemote => {
                ApiError::BadRequest("Project has no repository with a GitHub remote".to_string())
            }
            ProjectIssuesError::GhCliNotAvailable => {
                ApiError::BadRequest("`gh` CLI is not installed or not on PATH".to_string())
            }
            ProjectIssuesError::GhCommandFailed(msg) => {
                ApiError::BadGateway(format!("`gh issue list` failed: {msg}"))
            }
        }
    }
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/projects/{project_id}/issues", get(list_project_issues))
        .route(
            "/projects/{project_id}/issues/sync",
            post(sync_project_issues),
        )
}
