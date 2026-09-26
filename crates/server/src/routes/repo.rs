use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

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
use git::{FleetGraph, GitBranch, GitRemote};
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

/// Minimum interval between background remote-branch fetches for a given
/// repo path. The branches endpoint is polled from the UI (see
/// `useRepoBranches`); without this cooldown every poll would hit the
/// remote. Ten seconds keeps the second poll of a 20s frontend interval
/// authoritative — so a branch pushed elsewhere becomes visible in well
/// under the 30s promised by issue #559.
const BRANCH_FETCH_COOLDOWN: Duration = Duration::from_secs(10);

fn branch_fetch_last() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static LAST: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns `true` (and records the timestamp) when the caller should kick
/// off a background remote fetch for `repo_path`; returns `false` if the
/// last fetch was within [`BRANCH_FETCH_COOLDOWN`]. Recording the timestamp
/// on the *attempt* (not on success) keeps a broken remote from being
/// hammered on every poll.
fn should_fetch_branches(repo_path: &std::path::Path) -> bool {
    let mut guard = branch_fetch_last()
        .lock()
        .expect("branch fetch cooldown mutex poisoned");
    let now = Instant::now();
    if let Some(last) = guard.get(repo_path)
        && now.duration_since(*last) < BRANCH_FETCH_COOLDOWN
    {
        return false;
    }
    guard.insert(repo_path.to_path_buf(), now);
    true
}

pub async fn get_repo_branches(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitBranch>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    // Kick off a debounced background fetch so branches created directly on
    // the remote (or from another clone) show up on the next poll of the
    // selector. Fetch errors — offline, auth failure, no remote — are
    // deliberately swallowed so this endpoint never 500s on a bad network
    // (#559 sad path); the current call still returns the local list.
    if should_fetch_branches(&repo.path) {
        let git = deployment.git().clone();
        let path = repo.path.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(err) = git.fetch_default_remote_branches(&path) {
                tracing::debug!(
                    repo_path = %path.display(),
                    "background branch fetch failed: {}",
                    err
                );
            }
        });
    }

    let branches = deployment.git().get_all_branches(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(branches)))
}

pub async fn get_repo_tags(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<git::GitTagInfo>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let tags = deployment.git().get_all_tags(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(tags)))
}

#[derive(Debug, Deserialize)]
pub struct RepoGraphQuery {
    /// Base branch of the fleet (e.g. the shared target branch).
    base: String,
    /// Comma-separated attempt branch names; unresolvable ones are skipped.
    #[serde(default)]
    tips: String,
    limit: Option<usize>,
    offset: Option<usize>,
}

/// Fleet graph (SHELL-SPEC V4): multi-branch commit log for the Source
/// control section. Response type mirrored inline in the frontend client.
pub async fn get_repo_graph(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<RepoGraphQuery>,
) -> Result<ResponseJson<ApiResponse<FleetGraph>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let tips: Vec<String> = query
        .tips
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let limit = query.limit.unwrap_or(100).clamp(1, 3000);
    let offset = query.offset.unwrap_or(0).min(30_000);

    let git = deployment.git().clone();
    let base = query.base.clone();
    let graph = tokio::task::spawn_blocking(move || {
        git.get_fleet_graph(&repo.path, &base, &tips, limit, offset)
    })
    .await
    .map_err(|e| ApiError::BadRequest(format!("Graph walk failed: {e}")))??;

    Ok(ResponseJson(ApiResponse::success(graph)))
}

#[derive(Debug, Deserialize)]
pub struct GraphLocateQuery {
    base: String,
    #[serde(default)]
    tips: String,
    oid: String,
}

#[derive(Debug, Serialize)]
pub struct GraphLocateResponse {
    pub index: Option<usize>,
}

/// Where a commit sits in the fleet-graph ordering (sidebar → graph jumps).
pub async fn locate_repo_graph_commit(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<GraphLocateQuery>,
) -> Result<ResponseJson<ApiResponse<GraphLocateResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let tips: Vec<String> = query
        .tips
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let git = deployment.git().clone();
    let base = query.base.clone();
    let index = tokio::task::spawn_blocking(move || {
        git.locate_fleet_commit(&repo.path, &base, &tips, &query.oid)
    })
    .await
    .map_err(|e| ApiError::BadRequest(format!("Locate failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(GraphLocateResponse {
        index,
    })))
}

pub async fn get_repo_commit(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, oid)): Path<(Uuid, String)>,
) -> Result<ResponseJson<ApiResponse<git::CommitDetail>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git = deployment.git().clone();
    let detail = tokio::task::spawn_blocking(move || git.get_commit_detail(&repo.path, &oid))
        .await
        .map_err(|e| ApiError::BadRequest(format!("Commit lookup failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(detail)))
}

#[derive(Debug, Deserialize)]
pub struct CommitFileQuery {
    path: String,
}

#[derive(Debug, Serialize)]
pub struct CommitFileContent {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBranchRequest {
    pub name: String,
    pub at_oid: String,
}

/// Create a local branch at a commit (fleet graph inline action).
pub async fn create_repo_branch(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    axum::Json(request): axum::Json<CreateBranchRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest(
            "Branch name cannot be empty".to_string(),
        ));
    }
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git = deployment.git().clone();
    tokio::task::spawn_blocking(move || git.create_branch_at(&repo.path, &name, &request.at_oid))
        .await
        .map_err(|e| ApiError::BadRequest(format!("Branch creation failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Deserialize)]
pub struct CommitTreeQuery {
    #[serde(default)]
    path: String,
}

/// Directory listing at a commit, for the embedded editor's snapshot tree.
pub async fn get_repo_commit_tree(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, oid)): Path<(Uuid, String)>,
    Query(query): Query<CommitTreeQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<git::CommitTreeEntry>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git = deployment.git().clone();
    let entries =
        tokio::task::spawn_blocking(move || git.get_commit_tree(&repo.path, &oid, &query.path))
            .await
            .map_err(|e| ApiError::BadRequest(format!("Commit tree read failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(entries)))
}

#[derive(Debug, Serialize)]
pub struct CommitFileDiff {
    pub patch: String,
}

/// Unified diff of one file in a commit, for the editor's diff tabs.
pub async fn get_repo_commit_file_diff(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, oid)): Path<(Uuid, String)>,
    Query(query): Query<CommitFileQuery>,
) -> Result<ResponseJson<ApiResponse<CommitFileDiff>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git = deployment.git().clone();
    let patch = tokio::task::spawn_blocking(move || {
        git.get_commit_file_diff(&repo.path, &oid, &query.path)
    })
    .await
    .map_err(|e| ApiError::BadRequest(format!("Commit diff failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(CommitFileDiff { patch })))
}

/// Read-only file snapshot at a commit, for the embedded editor.
pub async fn get_repo_commit_file(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, oid)): Path<(Uuid, String)>,
    Query(query): Query<CommitFileQuery>,
) -> Result<ResponseJson<ApiResponse<CommitFileContent>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let git = deployment.git().clone();
    let content =
        tokio::task::spawn_blocking(move || git.get_commit_file(&repo.path, &oid, &query.path))
            .await
            .map_err(|e| ApiError::BadRequest(format!("Commit file read failed: {e}")))??;
    Ok(ResponseJson(ApiResponse::success(CommitFileContent {
        content,
    })))
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
    /// When the issue was closed; `null` while open, and also for closed issues
    /// not yet re-synced since `closed_at` was introduced.
    #[ts(type = "Date | null")]
    pub closed_at: Option<DateTime<Utc>>,
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
            closed_at: issue.closed_at,
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
        .route(
            "/repos/{repo_id}/branches",
            get(get_repo_branches).post(create_repo_branch),
        )
        .route("/repos/{repo_id}/tags", get(get_repo_tags))
        .route("/repos/{repo_id}/graph", get(get_repo_graph))
        .route(
            "/repos/{repo_id}/graph/locate",
            get(locate_repo_graph_commit),
        )
        .route("/repos/{repo_id}/commits/{oid}", get(get_repo_commit))
        .route(
            "/repos/{repo_id}/commits/{oid}/file",
            get(get_repo_commit_file),
        )
        .route(
            "/repos/{repo_id}/commits/{oid}/tree",
            get(get_repo_commit_tree),
        )
        .route(
            "/repos/{repo_id}/commits/{oid}/file-diff",
            get(get_repo_commit_file_diff),
        )
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
