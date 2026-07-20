use std::path::PathBuf;

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{delete, get, post, put},
};
use chrono::{DateTime, Utc};
use db::models::{
    repo::{Repo, SearchResult, UpdateRepo},
    repo_issue::RepoIssue,
};
use deployment::Deployment;
use git::{GitBranch, GitRemote};
use git_host::{GitHostError, GitHostProvider, GitHostService, ProviderKind, PullRequestDetail};
use serde::{Deserialize, Serialize};
use services::services::{
    file_search::SearchQuery,
    repo_issues::{
        RepoIssuesError, RepoIssuesService, StoredLabel, derive_priority, parse_stored_labels,
    },
};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(serde::Deserialize)]
pub struct OpenEditorRequest {
    pub editor_type: Option<String>,
    pub git_repo_path: Option<PathBuf>,
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct RegisterRepoRequest {
    pub path: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct InitRepoRequest {
    pub parent_path: String,
    pub folder_name: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct BatchRepoRequest {
    pub ids: Vec<Uuid>,
}

pub async fn register_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<RegisterRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .register(
            &deployment.db().pool,
            deployment.git(),
            &payload.path,
            payload.display_name.as_deref(),
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn init_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<InitRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .init_repo(
            &deployment.db().pool,
            deployment.git(),
            &payload.parent_path,
            &payload.folder_name,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn get_repo_branches(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitBranch>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let branches = deployment.git().get_all_branches(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(branches)))
}

pub async fn get_repo_remotes(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitRemote>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remotes = deployment.git().list_remotes(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(remotes)))
}

pub async fn get_repos_batch(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<BatchRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::find_by_ids(&deployment.db().pool, &payload.ids).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_all(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_recent_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_by_recent_workspace_usage(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn update_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<UpdateRepo>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = Repo::update(&deployment.db().pool, repo_id, &payload).await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn open_repo_in_editor(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<Option<OpenEditorRequest>>,
) -> Result<ResponseJson<ApiResponse<OpenEditorResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let editor_config = {
        let config = deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(&repo.path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for repo {} at path: {}{}",
                repo_id,
                repo.path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            deployment
                .track_if_analytics_allowed(
                    "repo_editor_opened",
                    serde_json::json!({
                        "repo_id": repo_id.to_string(),
                        "editor_type": payload.as_ref().and_then(|req| req.editor_type.as_ref()),
                        "remote_mode": url.is_some(),
                    }),
                )
                .await;

            Ok(ResponseJson(ApiResponse::success(OpenEditorResponse {
                url,
            })))
        }
        Err(e) => {
            tracing::error!("Failed to open editor for repo {}: {:?}", repo_id, e);
            Err(ApiError::EditorOpen(e))
        }
    }
}

pub async fn search_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(search_query): Query<SearchQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<SearchResult>>>, StatusCode> {
    if search_query.q.trim().is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "Query parameter 'q' is required and cannot be empty",
        )));
    }

    let repo = match deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await
    {
        Ok(repo) => repo,
        Err(e) => {
            tracing::error!("Failed to get repo {}: {}", repo_id, e);
            return Err(StatusCode::NOT_FOUND);
        }
    };

    match deployment
        .file_search_cache()
        .search_repo(&repo.path, &search_query.q, search_query.mode)
        .await
    {
        Ok(results) => Ok(ResponseJson(ApiResponse::success(results))),
        Err(e) => {
            tracing::error!("Failed to search files in repo {}: {}", repo_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ListPrsError {
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
}

#[derive(Debug, Deserialize)]
pub struct ListPrsQuery {
    pub remote: Option<String>,
}

pub async fn list_open_prs(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<ListPrsQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<PullRequestDetail>, ListPrsError>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remote = match query.remote {
        Some(name) => GitRemote {
            url: deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => deployment.git().get_default_remote(&repo.path)?,
    };

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                ListPrsError::UnsupportedProvider,
            )));
        }
        Err(e) => {
            tracing::error!("Failed to create git host service: {}", e);
            return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
        }
    };

    match git_host.list_open_prs(&repo.path, &remote.url).await {
        Ok(prs) => Ok(ResponseJson(ApiResponse::success(prs))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(GitHostError::UnsupportedProvider) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::UnsupportedProvider,
        ))),
        Err(e) => {
            tracing::error!("Failed to list open PRs for repo {}: {}", repo_id, e);
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PrInfoQuery {
    pub url: String,
}

pub async fn get_pr_info(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<PrInfoQuery>,
) -> Result<ResponseJson<ApiResponse<PullRequestDetail, ListPrsError>>, ApiError> {
    let git_host = match GitHostService::from_url(&query.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                ListPrsError::UnsupportedProvider,
            )));
        }
        Err(e) => {
            tracing::error!("Failed to create git host service: {}", e);
            return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
        }
    };

    match git_host.get_pr_status(&query.url).await {
        Ok(info) => Ok(ResponseJson(ApiResponse::success(info))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(GitHostError::UnsupportedProvider) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::UnsupportedProvider,
        ))),
        Err(e) => {
            tracing::error!("Failed to get PR info for {}: {}", query.url, e);
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

#[derive(Debug, Serialize, TS)]
pub struct DeleteRepoConflict {
    pub message: String,
    pub workspaces: Vec<String>,
}

pub async fn delete_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<
    (
        StatusCode,
        ResponseJson<ApiResponse<(), DeleteRepoConflict>>,
    ),
    ApiError,
> {
    let active = Repo::active_workspace_names(&deployment.db().pool, repo_id).await?;
    if !active.is_empty() {
        return Ok((
            StatusCode::CONFLICT,
            ResponseJson(ApiResponse::error_with_data(DeleteRepoConflict {
                message: format!("Repository is used by {} active workspace(s)", active.len()),
                workspaces: active,
            })),
        ));
    }

    Repo::delete(&deployment.db().pool, repo_id).await?;
    Ok((StatusCode::OK, ResponseJson(ApiResponse::success(()))))
}

// ---------------------------------------------------------------------------
// Issue types and handlers
// ---------------------------------------------------------------------------

/// A GitHub label as returned by the API. `color` is a 6-digit hex without '#'.
#[derive(Debug, Serialize, TS)]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
}

impl From<StoredLabel> for IssueLabel {
    fn from(l: StoredLabel) -> Self {
        Self {
            name: l.name,
            color: l.color,
        }
    }
}

#[derive(Debug, Serialize, TS)]
pub struct RepoIssueResponse {
    pub id: Uuid,
    pub repo_id: Uuid,
    #[ts(type = "number")]
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub labels: Vec<IssueLabel>,
    pub author: String,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub synced_at: DateTime<Utc>,
    pub milestone: Option<String>,
    pub priority: Option<String>,
}

impl From<RepoIssue> for RepoIssueResponse {
    fn from(issue: RepoIssue) -> Self {
        let stored = parse_stored_labels(&issue.labels);
        let priority = derive_priority(&stored);
        let labels: Vec<IssueLabel> = stored.into_iter().map(Into::into).collect();
        Self {
            id: issue.id,
            repo_id: issue.repo_id,
            number: issue.number,
            title: issue.title,
            body: issue.body.unwrap_or_default(),
            state: issue.state,
            labels,
            author: issue.author.unwrap_or_default(),
            updated_at: issue.updated_at,
            synced_at: issue.synced_at,
            milestone: issue.milestone,
            priority,
        }
    }
}

pub async fn list_repo_issues(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoIssueResponse>>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let issues = RepoIssuesService::new().list(&pool, repo_id).await?;
    let response: Vec<RepoIssueResponse> = issues.into_iter().map(Into::into).collect();

    // Kick off a background refresh so the list stays fresh without
    // blocking the request. Errors are logged only.
    let git = deployment.git().clone();
    tokio::spawn(async move {
        if let Err(err) = RepoIssuesService::new().sync(&pool, &git, repo_id).await {
            tracing::debug!(
                repo_id = %repo_id,
                "background repo issues sync failed: {}",
                err
            );
        }
    });

    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn sync_repo_issues(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoIssueResponse>>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let service = RepoIssuesService::new();
    service.sync(&pool, deployment.git(), repo_id).await?;
    let issues = service.list(&pool, repo_id).await?;
    let response: Vec<RepoIssueResponse> = issues.into_iter().map(Into::into).collect();

    Ok(ResponseJson(ApiResponse::success(response)))
}

#[derive(Debug, Deserialize, TS)]
pub struct SetIssuePriorityRequest {
    pub priority: Option<String>,
}

pub async fn set_issue_priority(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
    ResponseJson(payload): ResponseJson<SetIssuePriorityRequest>,
) -> Result<ResponseJson<ApiResponse<RepoIssueResponse>>, ApiError> {
    let pool = deployment.db().pool.clone();
    RepoIssuesService::new()
        .set_priority(&pool, repo_id, issue_number, payload.priority.as_deref())
        .await?;

    let issue = RepoIssue::find_by_repo_and_number(&pool, repo_id, issue_number)
        .await
        .map_err(ApiError::Database)?
        .ok_or_else(|| ApiError::BadRequest("Issue not found".to_string()))?;

    Ok(ResponseJson(ApiResponse::success(RepoIssueResponse::from(
        issue,
    ))))
}

#[derive(Debug, Deserialize, TS)]
pub struct AddIssueLabelRequest {
    pub label: String,
    pub color: Option<String>,
}

pub async fn add_issue_label(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
    ResponseJson(payload): ResponseJson<AddIssueLabelRequest>,
) -> Result<ResponseJson<ApiResponse<RepoIssueResponse>>, ApiError> {
    let pool = deployment.db().pool.clone();
    RepoIssuesService::new()
        .add_label(
            &pool,
            repo_id,
            issue_number,
            &payload.label,
            payload.color.as_deref(),
        )
        .await?;

    let issue = RepoIssue::find_by_repo_and_number(&pool, repo_id, issue_number)
        .await
        .map_err(ApiError::Database)?
        .ok_or_else(|| ApiError::BadRequest("Issue not found".to_string()))?;

    Ok(ResponseJson(ApiResponse::success(RepoIssueResponse::from(
        issue,
    ))))
}

pub async fn remove_issue_label(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number, label_name)): Path<(Uuid, i64, String)>,
) -> Result<ResponseJson<ApiResponse<RepoIssueResponse>>, ApiError> {
    let pool = deployment.db().pool.clone();
    RepoIssuesService::new()
        .remove_label(&pool, repo_id, issue_number, &label_name)
        .await?;

    let issue = RepoIssue::find_by_repo_and_number(&pool, repo_id, issue_number)
        .await
        .map_err(ApiError::Database)?
        .ok_or_else(|| ApiError::BadRequest("Issue not found".to_string()))?;

    Ok(ResponseJson(ApiResponse::success(RepoIssueResponse::from(
        issue,
    ))))
}

pub async fn close_issue(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
) -> Result<ResponseJson<ApiResponse<RepoIssueResponse>>, ApiError> {
    let pool = deployment.db().pool.clone();
    RepoIssuesService::new()
        .close_issue(&pool, repo_id, issue_number)
        .await?;

    let issue = RepoIssue::find_by_repo_and_number(&pool, repo_id, issue_number)
        .await
        .map_err(ApiError::Database)?
        .ok_or_else(|| ApiError::BadRequest("Issue not found".to_string()))?;

    Ok(ResponseJson(ApiResponse::success(RepoIssueResponse::from(
        issue,
    ))))
}

impl From<RepoIssuesError> for ApiError {
    fn from(err: RepoIssuesError) -> Self {
        match err {
            RepoIssuesError::Sqlx(e) => ApiError::Database(e),
            RepoIssuesError::Io(e) => ApiError::Io(e),
            RepoIssuesError::Json(e) => {
                ApiError::BadGateway(format!("Failed to parse gh output: {e}"))
            }
            RepoIssuesError::RepoNotFound => {
                ApiError::BadRequest("Repository not found".to_string())
            }
            RepoIssuesError::NoGithubRemote => {
                ApiError::BadRequest("Repository has no GitHub remote".to_string())
            }
            RepoIssuesError::NotGithubOrigin(url) => {
                ApiError::BadRequest(format!("origin remote URL is not a GitHub URL: {url}"))
            }
            RepoIssuesError::GhCliNotAvailable => {
                ApiError::BadRequest("`gh` CLI is not installed or not on PATH".to_string())
            }
            RepoIssuesError::GhCommandFailed(msg) => {
                ApiError::BadGateway(format!("`gh` command failed: {msg}"))
            }
            RepoIssuesError::IssueNotFound => ApiError::BadRequest("Issue not found".to_string()),
            RepoIssuesError::InvalidPriority(p) => {
                ApiError::BadRequest(format!("Invalid priority value: {p}"))
            }
        }
    }
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/repos", get(get_repos).post(register_repo))
        .route("/repos/recent", get(get_recent_repos))
        .route("/repos/init", post(init_repo))
        .route("/repos/batch", post(get_repos_batch))
        .route(
            "/repos/{repo_id}",
            get(get_repo).put(update_repo).delete(delete_repo),
        )
        .route("/repos/{repo_id}/branches", get(get_repo_branches))
        .route("/repos/{repo_id}/remotes", get(get_repo_remotes))
        .route("/repos/{repo_id}/prs", get(list_open_prs))
        .route("/repos/pr-info", get(get_pr_info))
        .route("/repos/{repo_id}/search", get(search_repo))
        .route("/repos/{repo_id}/open-editor", post(open_repo_in_editor))
        .route("/repos/{repo_id}/issues", get(list_repo_issues))
        .route("/repos/{repo_id}/issues/sync", post(sync_repo_issues))
        .route(
            "/repos/{repo_id}/issues/{issue_number}/priority",
            put(set_issue_priority),
        )
        .route(
            "/repos/{repo_id}/issues/{issue_number}/labels",
            post(add_issue_label),
        )
        .route(
            "/repos/{repo_id}/issues/{issue_number}/labels/{label_name}",
            delete(remove_issue_label),
        )
        .route(
            "/repos/{repo_id}/issues/{issue_number}/close",
            post(close_issue),
        )
}
