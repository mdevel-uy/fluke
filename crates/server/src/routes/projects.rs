use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use db::models::{project::Project, project_issue::ProjectIssue, repo::Repo};
use deployment::Deployment;
use serde::Serialize;
use services::services::project_issues::{ProjectIssuesError, ProjectIssuesService};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Serialize, TS)]
pub struct ProjectIssueResponse {
    pub id: Uuid,
    pub project_id: Uuid,
    #[ts(type = "number")]
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub labels: Vec<String>,
    pub author: String,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub synced_at: DateTime<Utc>,
}

impl From<ProjectIssue> for ProjectIssueResponse {
    fn from(issue: ProjectIssue) -> Self {
        let labels: Vec<String> = serde_json::from_str(&issue.labels).unwrap_or_default();
        Self {
            id: issue.id,
            project_id: issue.project_id,
            number: issue.number,
            title: issue.title,
            body: issue.body.unwrap_or_default(),
            state: issue.state,
            labels,
            author: issue.author.unwrap_or_default(),
            updated_at: issue.updated_at,
            synced_at: issue.synced_at,
        }
    }
}

pub async fn list_project_issues(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<ProjectIssueResponse>>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let issues = ProjectIssuesService::new().list(&pool, project_id).await?;
    let response: Vec<ProjectIssueResponse> = issues.into_iter().map(Into::into).collect();

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

    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn sync_project_issues(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<ProjectIssueResponse>>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let service = ProjectIssuesService::new();
    service.sync(&pool, deployment.git(), project_id).await?;
    let issues = service.list(&pool, project_id).await?;
    let response: Vec<ProjectIssueResponse> = issues.into_iter().map(Into::into).collect();

    Ok(ResponseJson(ApiResponse::success(response)))
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

pub async fn list_project_repos(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let pool = &deployment.db().pool;
    if Project::find_by_id(pool, project_id).await?.is_none() {
        return Err(ApiError::BadRequest("Project not found".to_string()));
    }
    let repo_ids = Project::repo_ids(pool, project_id).await?;
    let repos = Repo::find_by_ids(pool, &repo_ids).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/projects/{project_id}/issues", get(list_project_issues))
        .route(
            "/projects/{project_id}/issues/sync",
            post(sync_project_issues),
        )
        .route("/projects/{project_id}/repos", get(list_project_repos))
}
