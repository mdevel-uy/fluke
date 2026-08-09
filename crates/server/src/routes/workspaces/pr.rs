use std::path::PathBuf;

use api_types::{PullRequestStatus, UpsertPullRequestRequest};
use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    merge::{Merge, MergeStatus},
    pull_request::PullRequest,
    repo::{Repo, RepoError},
    session::{CreateSession, Session},
    worker::Worker,
    workspace::{CreateWorkspace, Workspace, WorkspaceError},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    coding_agent_initial::CodingAgentInitialRequest,
};
use git::{GitCliError, GitRemote, GitServiceError, PreMergeOutcome};
use git_host::{
    CreatePrRequest, GitHostError, GitHostProvider, GitHostService, PrFailedCheck, ProviderKind,
    UnifiedPrComment, github::GhCli,
};
use serde::{Deserialize, Serialize};
use services::services::{
    config::DEFAULT_PR_DESCRIPTION_PROMPT, container::ContainerService, quick_action_prompts,
    remote_sync,
};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CreatePrApiRequest {
    pub title: String,
    pub body: Option<String>,
    pub target_branch: Option<String>,
    pub draft: Option<bool>,
    pub repo_id: Uuid,
    #[serde(default)]
    pub auto_generate_description: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize, TS)]
pub struct AttachPrResponse {
    pub pr_attached: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<MergeStatus>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct AttachExistingPrRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, TS)]
pub struct PrCommentsResponse {
    pub comments: Vec<UnifiedPrComment>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GetPrCommentsError {
    NoPrAttached,
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
}

#[derive(Debug, Deserialize, TS)]
pub struct GetPrCommentsQuery {
    pub repo_id: Uuid,
}

async fn trigger_pr_description_follow_up(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    pr_number: i64,
    pr_url: &str,
) -> Result<(), ApiError> {
    // Get the custom prompt from config, or use default
    let config = deployment.config().read().await;
    let prompt_template = config
        .pr_auto_description_prompt
        .as_deref()
        .unwrap_or(DEFAULT_PR_DESCRIPTION_PROMPT);

    // Replace placeholders in prompt
    let prompt = prompt_template
        .replace("{pr_number}", &pr_number.to_string())
        .replace("{pr_url}", pr_url);

    drop(config); // Release the lock before async operations

    // Get or create a session for this follow-up
    let session =
        match Session::find_latest_by_workspace_id(&deployment.db().pool, workspace.id).await? {
            Some(s) => s,
            None => {
                Session::create(
                    &deployment.db().pool,
                    &CreateSession {
                        executor: None,
                        name: None,
                    },
                    Uuid::new_v4(),
                    workspace.id,
                )
                .await?
            }
        };

    // Get executor profile from the latest coding agent process in this session
    let Some(executor_profile_id) =
        ExecutionProcess::latest_executor_profile_for_session(&deployment.db().pool, session.id)
            .await?
    else {
        tracing::warn!(
            "No executor profile found for session {}, skipping PR description follow-up",
            session.id
        );
        return Ok(());
    };

    // Get latest agent turn if one exists (for coding agent continuity)
    let latest_session_info =
        CodingAgentTurn::find_latest_session_info(&deployment.db().pool, session.id).await?;

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    // Build the action type (follow-up if session exists, otherwise initial)
    let action_type = if let Some(info) = latest_session_info {
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt,
            session_id: info.session_id,
            reset_to_message_id: None,
            executor_config: executors::profile::ExecutorConfig::from(executor_profile_id.clone()),
            working_dir: working_dir.clone(),
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt,
            executor_config: executors::profile::ExecutorConfig::from(executor_profile_id.clone()),
            working_dir,
        })
    };

    let action = ExecutorAction::new(action_type, None);

    deployment
        .container()
        .start_execution(
            workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    Ok(())
}

pub async fn create_pr(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CreatePrApiRequest>,
) -> Result<ResponseJson<ApiResponse<String, PrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo_path = repo.path.clone();
    let target_branch = if let Some(branch) = request.target_branch {
        branch
    } else {
        workspace_repo.target_branch.clone()
    };

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = PathBuf::from(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    let git = deployment.git();
    let push_remote = git.resolve_remote_for_branch(&repo_path, &workspace.branch)?;

    // Try to get the remote from the branch name (works for remote-tracking branches like "upstream/main").
    // Fall back to push_remote if the branch doesn't exist locally or isn't a remote-tracking branch.
    let (target_remote, base_branch) =
        match git.get_remote_from_branch_name(&repo_path, &target_branch) {
            Ok(remote) => {
                let branch = target_branch
                    .strip_prefix(&format!("{}/", remote.name))
                    .unwrap_or(&target_branch);
                (remote, branch.to_string())
            }
            Err(_) => (push_remote.clone(), target_branch.clone()),
        };

    match git.check_remote_branch_exists(&repo_path, &target_remote.url, &base_branch) {
        Ok(false) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::TargetBranchNotFound {
                    branch: target_branch.clone(),
                },
            )));
        }
        Err(GitServiceError::GitCLI(GitCliError::AuthFailed(_))) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::GitCliNotLoggedIn,
            )));
        }
        Err(GitServiceError::GitCLI(GitCliError::NotAvailable)) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::GitCliNotInstalled,
            )));
        }
        Err(e) => return Err(ApiError::GitService(e)),
        Ok(true) => {}
    }

    // Resolve the author worker's PAT (if any) so push AND PR creation
    // authenticate as that worker's GitHub identity instead of relying on
    // the machine's global gh credentials. Manual PR creation from the UI
    // hits this path — same identity story as agent-driven creation.
    let worker_pat =
        Worker::find_github_pat_by_workspace_id(pool, workspace.id).await?;

    // Branch name on the remote — differs from the local branch only for
    // workspaces created from an existing PR.
    let remote_branch = Workspace::remote_branch_name(pool, workspace.id).await?;

    if let Err(e) = git.push_to_remote_with_token(
        &worktree_path,
        &workspace.branch,
        &remote_branch,
        false,
        worker_pat.as_deref(),
    ) {
        tracing::error!("Failed to push branch to remote: {}", e);
        match e {
            GitServiceError::GitCLI(GitCliError::AuthFailed(_)) => {
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::GitCliNotLoggedIn,
                )));
            }
            GitServiceError::GitCLI(GitCliError::NotAvailable) => {
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::GitCliNotInstalled,
                )));
            }
            _ => return Err(ApiError::GitService(e)),
        }
    }

    let git_host = match GitHostService::from_url_with_token(&target_remote.url, worker_pat.clone())
    {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::UnsupportedProvider,
            )));
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    // Create the PR
    let pr_request = CreatePrRequest {
        title: request.title.clone(),
        body: request.body.clone(),
        head_branch: remote_branch.clone(),
        base_branch: base_branch.clone(),
        draft: request.draft,
        head_repo_url: Some(push_remote.url.clone()),
    };

    match git_host
        .create_pr(&repo_path, &target_remote.url, &pr_request)
        .await
    {
        Ok(pr_info) => {
            // Track the PR locally
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace.id,
                workspace_repo.repo_id,
                &base_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            {
                tracing::error!("Failed to create local PR record: {}", e);
            }

            if let Ok(client) = deployment.remote_client() {
                let request = UpsertPullRequestRequest {
                    url: pr_info.url.clone(),
                    number: pr_info.number as i32,
                    status: PullRequestStatus::Open,
                    merged_at: None,
                    merge_commit_sha: None,
                    target_branch_name: base_branch.clone(),
                    local_workspace_id: workspace.id,
                };
                tokio::spawn(async move {
                    remote_sync::sync_pr_to_remote(&client, request).await;
                });
            }

            // Auto-open PR in browser
            if let Err(e) = utils::browser::open_browser(&pr_info.url).await {
                tracing::warn!("Failed to open PR in browser: {}", e);
            }

            deployment
                .track_if_analytics_allowed(
                    "pr_created",
                    serde_json::json!({
                        "workspace_id": workspace.id.to_string(),
                        "provider": format!("{:?}", provider),
                    }),
                )
                .await;

            // Trigger auto-description follow-up if enabled
            if request.auto_generate_description
                && let Err(e) = trigger_pr_description_follow_up(
                    &deployment,
                    &workspace,
                    pr_info.number,
                    &pr_info.url,
                )
                .await
            {
                tracing::warn!(
                    "Failed to trigger PR description follow-up for attempt {}: {}",
                    workspace.id,
                    e
                );
            }

            Ok(ResponseJson(ApiResponse::success(pr_info.url)))
        }
        Err(e) => {
            tracing::error!(
                "Failed to create PR for attempt {} using {:?}: {}",
                workspace.id,
                provider,
                e
            );

            // If GitHub says the PR already exists (agent created it via gh cli),
            // fall back to adopting it so the UI sees it as if it were created here.
            if let GitHostError::PullRequest(msg) = &e {
                if msg.to_ascii_lowercase().contains("already exists") {
                    tracing::info!(
                        workspace_id = %workspace.id,
                        branch = %remote_branch,
                        "PR already exists on GitHub; adopting instead",
                    );
                    match git_host
                        .list_prs_for_branch(&repo_path, &target_remote.url, &remote_branch)
                        .await
                    {
                        Ok(prs) => {
                            if let Some(pr_info) = prs.into_iter().next() {
                                if let Err(db_err) = PullRequest::create_for_workspace(
                                    pool,
                                    workspace.id,
                                    workspace_repo.repo_id,
                                    &base_branch,
                                    pr_info.number,
                                    &pr_info.url,
                                )
                                .await
                                {
                                    tracing::error!(
                                        "Failed to create local PR record during adoption fallback: {}",
                                        db_err
                                    );
                                }

                                if let Ok(client) = deployment.remote_client() {
                                    let pr_status = match &pr_info.status {
                                        MergeStatus::Open => PullRequestStatus::Open,
                                        MergeStatus::Merged => PullRequestStatus::Merged,
                                        MergeStatus::Closed => PullRequestStatus::Closed,
                                        MergeStatus::Unknown => PullRequestStatus::Open,
                                    };
                                    let upsert_req = UpsertPullRequestRequest {
                                        url: pr_info.url.clone(),
                                        number: pr_info.number as i32,
                                        status: pr_status,
                                        merged_at: pr_info.merged_at,
                                        merge_commit_sha: pr_info.merge_commit_sha.clone(),
                                        target_branch_name: base_branch.clone(),
                                        local_workspace_id: workspace.id,
                                    };
                                    tokio::spawn(async move {
                                        remote_sync::sync_pr_to_remote(&client, upsert_req).await;
                                    });
                                }

                                if let Err(open_err) =
                                    utils::browser::open_browser(&pr_info.url).await
                                {
                                    tracing::warn!(
                                        "Failed to open adopted PR in browser: {}",
                                        open_err
                                    );
                                }

                                return Ok(ResponseJson(ApiResponse::success(pr_info.url)));
                            }
                        }
                        Err(list_err) => {
                            tracing::warn!(
                                "Failed to list PRs for adoption fallback (workspace {}): {}",
                                workspace.id,
                                list_err
                            );
                        }
                    }
                }
            }

            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(ResponseJson(
                    ApiResponse::error_with_data(PrError::CliNotInstalled {
                        provider: *provider,
                    }),
                )),
                GitHostError::AuthFailed(_) => Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::CliNotLoggedIn { provider },
                ))),
                _ => Err(ApiError::GitHost(e)),
            }
        }
    }
}

pub async fn attach_existing_pr(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<AttachExistingPrRequest>,
) -> Result<ResponseJson<ApiResponse<AttachPrResponse, PrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Check if PR already attached for this repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id).await?;
    if let Some(Merge::Pr(pr_merge)) = merges.into_iter().next() {
        return Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: true,
            pr_url: Some(pr_merge.pr_info.url.clone()),
            pr_number: Some(pr_merge.pr_info.number),
            pr_status: Some(pr_merge.pr_info.status.clone()),
        })));
    }

    let git = deployment.git();
    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::UnsupportedProvider,
            )));
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    // List all PRs for branch (open, closed, and merged); PRs live under the
    // remote-facing branch name, which differs from the local one for
    // workspaces created from an existing PR.
    let remote_branch = Workspace::remote_branch_name(pool, workspace.id).await?;
    let prs = match git_host
        .list_prs_for_branch(&repo.path, &remote.url, &remote_branch)
        .await
    {
        Ok(prs) => prs,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(GitHostError::AuthFailed(_)) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotLoggedIn { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    // Take the first PR (prefer open, but also accept merged/closed)
    if let Some(pr_info) = prs.into_iter().next() {
        // Save PR info locally
        PullRequest::create_for_workspace(
            pool,
            workspace.id,
            workspace_repo.repo_id,
            &workspace_repo.target_branch,
            pr_info.number,
            &pr_info.url,
        )
        .await?;

        // Update status if not open
        if !matches!(pr_info.status, MergeStatus::Open) {
            let merged_at = if matches!(&pr_info.status, MergeStatus::Merged) {
                pr_info.merged_at
            } else {
                None
            };
            PullRequest::update_status(
                pool,
                &pr_info.url,
                &pr_info.status,
                merged_at,
                pr_info.merge_commit_sha.clone(),
            )
            .await?;
        }

        if let Ok(client) = deployment.remote_client() {
            let pr_status = match pr_info.status {
                MergeStatus::Open => PullRequestStatus::Open,
                MergeStatus::Merged => PullRequestStatus::Merged,
                MergeStatus::Closed => PullRequestStatus::Closed,
                MergeStatus::Unknown => PullRequestStatus::Open,
            };
            let request = UpsertPullRequestRequest {
                url: pr_info.url.clone(),
                number: pr_info.number as i32,
                status: pr_status,
                merged_at: None,
                merge_commit_sha: pr_info.merge_commit_sha.clone(),
                target_branch_name: workspace_repo.target_branch.clone(),
                local_workspace_id: workspace.id,
            };
            tokio::spawn(async move {
                remote_sync::sync_pr_to_remote(&client, request).await;
            });
        }

        // If PR is merged, archive workspace
        if matches!(pr_info.status, MergeStatus::Merged) {
            let open_pr_count = PullRequest::count_open_for_workspace(pool, workspace.id).await?;

            if open_pr_count == 0 {
                if !workspace.pinned
                    && let Err(e) = deployment.container().archive_workspace(workspace.id).await
                {
                    tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
                }
            } else {
                tracing::info!(
                    "PR #{} was merged, leaving workspace {} active with {} open PR(s)",
                    pr_info.number,
                    workspace.id,
                    open_pr_count
                );
            }
        }

        Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: true,
            pr_url: Some(pr_info.url),
            pr_number: Some(pr_info.number),
            pr_status: Some(pr_info.status),
        })))
    } else {
        Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: false,
            pr_url: None,
            pr_number: None,
            pr_status: None,
        })))
    }
}

pub async fn get_pr_comments(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<GetPrCommentsQuery>,
) -> Result<ResponseJson<ApiResponse<PrCommentsResponse, GetPrCommentsError>>, ApiError> {
    let pool = &deployment.db().pool;

    // Look up the specific repo using the multi-repo pattern
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, query.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Find the merge/PR for this specific repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, query.repo_id).await?;

    // Ensure there's an attached PR for this repo
    let pr_info = match merges.into_iter().next() {
        Some(Merge::Pr(pr_merge)) => pr_merge.pr_info,
        _ => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                GetPrCommentsError::NoPrAttached,
            )));
        }
    };

    let git = deployment.git();
    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                GetPrCommentsError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    match git_host
        .get_pr_comments(&repo.path, &remote.url, pr_info.number)
        .await
    {
        Ok(comments) => Ok(ResponseJson(ApiResponse::success(PrCommentsResponse {
            comments,
        }))),
        Err(e) => {
            tracing::error!(
                "Failed to fetch PR comments for attempt {}, PR #{}: {}",
                workspace.id,
                pr_info.number,
                e
            );
            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(ResponseJson(
                    ApiResponse::error_with_data(GetPrCommentsError::CliNotInstalled {
                        provider: *provider,
                    }),
                )),
                GitHostError::AuthFailed(_) => Ok(ResponseJson(ApiResponse::error_with_data(
                    GetPrCommentsError::CliNotLoggedIn { provider },
                ))),
                _ => Err(ApiError::GitHost(e)),
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceFromPrBody {
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub pr_title: String,
    pub pr_url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub run_setup: bool,
    pub remote_name: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
}

/// Best-effort cleanup of partially-created workspace resources.
/// Used when workspace creation from PR fails after DB records and filesystem
/// resources have already been created.
///
/// DB records are deleted synchronously (fast). Filesystem cleanup is spawned
/// as a background task to avoid blocking the error response.
async fn cleanup_failed_pr_workspace(pool: &sqlx::SqlitePool, workspace: &Workspace) {
    let workspace_id = workspace.id;

    // Gather data needed for background filesystem cleanup before deleting DB records
    let workspace_dir = workspace.container_ref.clone().map(PathBuf::from);
    let repositories = match WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await {
        Ok(repos) => repos,
        Err(e) => {
            tracing::warn!(
                "Failed to find repos for workspace {} during cleanup: {}",
                workspace_id,
                e
            );
            vec![]
        }
    };

    // Delete the workspace — FK CASCADE handles workspace_repos, sessions, merges, etc.
    if let Err(e) = Workspace::delete(pool, workspace_id).await {
        tracing::warn!(
            "Failed to delete workspace {} during cleanup: {}",
            workspace_id,
            e
        );
    }

    // Spawn background cleanup for filesystem resources (worktrees, workspace dir)
    if let Some(workspace_dir) = workspace_dir {
        tokio::spawn(async move {
            if let Err(e) = WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories).await
            {
                tracing::error!(
                    "Background cleanup failed for workspace {} at {}: {}",
                    workspace_id,
                    workspace_dir.display(),
                    e
                );
            }
        });
    }
}

#[axum::debug_handler]
pub async fn create_workspace_from_pr(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkspaceFromPrBody>,
) -> Result<ResponseJson<ApiResponse<CreateWorkspaceFromPrResponse, CreateFromPrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let remote = match payload.remote_name {
        Some(ref name) => GitRemote {
            url: deployment.git().get_remote_url(&repo.path, name)?,
            name: name.clone(),
        },
        None => deployment.git().get_default_remote(&repo.path)?,
    };

    // Use target branch initially - we'll switch to PR branch via gh pr checkout
    let target_branch_ref = format!("{}/{}", remote.name, payload.base_branch);

    // Create workspace with target branch initially
    let workspace_id = Uuid::new_v4();

    // The PR's head branch may already be checked out by the workspace that
    // authored the PR, and git refuses to check out one branch in two
    // worktrees. So this workspace gets its own unique local branch (same
    // scheme as regular attempts) and records the PR head as its
    // `remote_branch`: every push uses an explicit local:remote refspec to
    // keep updating the PR.
    let local_branch = deployment
        .container()
        .git_branch_from_workspace(&workspace_id, &payload.pr_title)
        .await;
    let mut workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: target_branch_ref.clone(),
            name: Some(payload.pr_title.clone()),
        },
        workspace_id,
    )
    .await?;

    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &[CreateWorkspaceRepo {
            repo_id: payload.repo_id,
            target_branch: target_branch_ref.clone(),
        }],
    )
    .await?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    // Update workspace with container_ref so start_execution can find it
    workspace.container_ref = Some(container_ref.clone());

    // Use gh pr checkout to fetch and switch to the PR branch
    // This handles SSH/HTTPS auth correctly regardless of fork URL format
    let worktree_path = PathBuf::from(&container_ref).join(&repo.name);
    match GhCli::new().get_repo_info(&remote.url, &worktree_path) {
        Ok(repo_info) => {
            if let Err(e) = GhCli::new().pr_checkout(
                &worktree_path,
                &repo_info.owner,
                &repo_info.repo_name,
                payload.pr_number,
                Some(&local_branch),
            ) {
                tracing::error!("Failed to checkout PR branch: {e}");
                cleanup_failed_pr_workspace(pool, &workspace).await;
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    CreateFromPrError::BranchFetchFailed {
                        message: e.to_string(),
                    },
                )));
            }
            // Unique local branch; pushes map to the PR head via remote_branch
            Workspace::update_branch_name(pool, workspace.id, &local_branch).await?;
            Workspace::set_remote_branch(pool, workspace.id, &payload.head_branch).await?;
            workspace.branch = local_branch.clone();
        }
        Err(e) => {
            tracing::error!(
                "Failed to get repo info for PR checkout (gh CLI may not be installed): {e}"
            );
            cleanup_failed_pr_workspace(pool, &workspace).await;
            return Ok(ResponseJson(ApiResponse::error_with_data(
                CreateFromPrError::BranchFetchFailed {
                    message: format!("Failed to get repository info: {e}"),
                },
            )));
        }
    }

    PullRequest::create_for_workspace(
        pool,
        workspace.id,
        payload.repo_id,
        &format!("{}/{}", remote.name, payload.base_branch),
        payload.pr_number,
        &payload.pr_url,
    )
    .await?;

    if payload.run_setup {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        if let Some(setup_action) = deployment.container().setup_actions_for_repos(&repos) {
            let session = Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?;

            if let Err(e) = deployment
                .container()
                .start_execution(
                    &workspace,
                    &session,
                    &setup_action,
                    &ExecutionProcessRunReason::SetupScript,
                )
                .await
            {
                tracing::error!("Failed to run setup script: {}", e);
            }
        }
    }

    deployment
        .track_if_analytics_allowed(
            "workspace_created_from_pr",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
                "pr_number": payload.pr_number,
                "run_setup": payload.run_setup,
            }),
        )
        .await;

    tracing::info!(
        "Created workspace {} from PR #{}",
        workspace.id,
        payload.pr_number,
    );

    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or(WorkspaceError::WorkspaceNotFound)?;

    Ok(ResponseJson(ApiResponse::success(
        CreateWorkspaceFromPrResponse { workspace },
    )))
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ResolveMergeConflictsError {
    NoPrAttached,
    NoAgentSession,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum AddressPrCommentsError {
    NoPrAttached,
    NoAgentSession,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum FixCiError {
    NoPrAttached,
    NoAgentSession,
}

/// Internal outcome for the shared quick-action dispatch: either the follow-up
/// was queued for the workspace agent, or the workspace has no coding-agent
/// session to attach it to (which each endpoint maps to its own typed error).
/// Callers verify PR presence before invoking, so "no PR attached" is not a
/// dispatch outcome.
enum QuickActionDispatchOutcome {
    Dispatched,
    NoAgentSession,
}

/// Send a fully-formatted follow-up prompt to the workspace's coding agent —
/// creating a session if none exists and reusing the latest agent turn so the
/// conversation stays continuous. Shared by "Fix merge conflicts", "Address PR
/// comments" and "Fix CI".
async fn dispatch_quick_action_follow_up(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    prompt: String,
) -> Result<QuickActionDispatchOutcome, ApiError> {
    let pool = &deployment.db().pool;

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let Some(executor_profile_id) =
        ExecutionProcess::latest_executor_profile_for_session(pool, session.id).await?
    else {
        tracing::warn!(
            workspace_id = %workspace.id,
            "No executor profile for quick-action follow-up; skipping",
        );
        return Ok(QuickActionDispatchOutcome::NoAgentSession);
    };

    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    let action_type = if let Some(info) = latest_session_info {
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt,
            session_id: info.session_id,
            reset_to_message_id: None,
            executor_config: executors::profile::ExecutorConfig::from(executor_profile_id),
            working_dir,
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt,
            executor_config: executors::profile::ExecutorConfig::from(executor_profile_id),
            working_dir,
        })
    };

    let action = ExecutorAction::new(action_type, None);

    deployment
        .container()
        .start_execution(
            workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    Ok(QuickActionDispatchOutcome::Dispatched)
}

/// Result of the pre-merge stage that runs before the resolve-merge-conflicts
/// quick action decides whether to dispatch an agent (issue #370).
enum PreMergeAttempt {
    /// Merge came out clean and the merge commit was pushed to the PR's
    /// remote — no agent needed.
    CleanAndPushed,
    /// Merge stopped with real conflicts; the worktree is left with the merge
    /// in progress. `files` is passed inline to the agent prompt.
    Conflicts { files: Vec<String> },
    /// Something in the pre-merge pipeline exploded before we could reach a
    /// definitive verdict (missing worktree, PR not linked to a repo, git
    /// error). The worktree is guaranteed to be back to its pre-call state.
    /// The caller falls back to the classic full prompt so the agent can
    /// re-do the merge itself.
    Fallback,
}

/// Run the pre-merge attempt for the "Fix merge conflicts" quick action.
///
/// Best-effort: any environmental failure (missing container, non-existent
/// repo, unrecognised remote, dirty worktree, etc.) is logged as a warn and
/// returns `PreMergeAttempt::Fallback` so the caller dispatches the classic
/// prompt. The worktree is only mutated when we have every piece we need,
/// and any partial state is aborted before we bubble up (see
/// [`git::GitService::pre_merge_target_branch`]).
async fn attempt_pre_merge_for_pr(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    open_pr: &PullRequest,
) -> PreMergeAttempt {
    let pool = &deployment.db().pool;

    let Some(repo_id) = open_pr.repo_id else {
        tracing::warn!(
            workspace_id = %workspace.id,
            pr_url = %open_pr.pr_url,
            "Open PR has no repo_id — skipping pre-merge and falling back",
        );
        return PreMergeAttempt::Fallback;
    };

    let repo = match Repo::find_by_id(pool, repo_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                "Repo for open PR not found — skipping pre-merge and falling back",
            );
            return PreMergeAttempt::Fallback;
        }
        Err(e) => {
            tracing::warn!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                "Failed to load repo for pre-merge: {e}",
            );
            return PreMergeAttempt::Fallback;
        }
    };

    let container_ref = match deployment
        .container()
        .ensure_container_exists(workspace)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                "Failed to materialize workspace for pre-merge: {e}",
            );
            return PreMergeAttempt::Fallback;
        }
    };
    let worktree_path = PathBuf::from(&container_ref).join(&repo.name);

    let git = deployment.git();
    let remote = match git.resolve_remote_for_branch(&repo.path, &open_pr.target_branch_name) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                "Failed to resolve remote for pre-merge: {e}",
            );
            return PreMergeAttempt::Fallback;
        }
    };

    let outcome = match git.pre_merge_target_branch(
        &worktree_path,
        &remote.url,
        &remote.name,
        &open_pr.target_branch_name,
    ) {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                "Pre-merge attempt failed — falling back to agent-driven merge: {e}",
            );
            return PreMergeAttempt::Fallback;
        }
    };

    match outcome {
        PreMergeOutcome::Clean { merge_commit_sha } => {
            // Push the merge commit through the standard push path so the PR
            // updates immediately and the mergeable state can flip back to
            // `mergeable` on the next monitor cycle. Uses the author worker's
            // PAT (when present) so the push is attributed to their identity,
            // matching the create-PR path.
            let worker_pat = match Worker::find_github_pat_by_workspace_id(pool, workspace.id).await
            {
                Ok(pat) => pat,
                Err(e) => {
                    tracing::warn!(
                        workspace_id = %workspace.id,
                        pr_url = %open_pr.pr_url,
                        "Failed to load worker PAT for pre-merge push: {e}",
                    );
                    None
                }
            };

            let remote_branch = match Workspace::remote_branch_name(pool, workspace.id).await {
                Ok(name) => name,
                Err(e) => {
                    tracing::warn!(
                        workspace_id = %workspace.id,
                        pr_url = %open_pr.pr_url,
                        "Failed to resolve remote branch for pre-merge push: {e}",
                    );
                    return PreMergeAttempt::Fallback;
                }
            };

            if let Err(e) = git.push_to_remote_with_token(
                &worktree_path,
                &workspace.branch,
                &remote_branch,
                false,
                worker_pat.as_deref(),
            ) {
                tracing::warn!(
                    workspace_id = %workspace.id,
                    pr_url = %open_pr.pr_url,
                    "Pre-merge push failed after clean merge: {e}",
                );
                return PreMergeAttempt::Fallback;
            }

            tracing::info!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                merge_commit_sha = %merge_commit_sha,
                "Pre-merge produced a clean merge; pushed without dispatching agent",
            );
            PreMergeAttempt::CleanAndPushed
        }
        PreMergeOutcome::Conflicts { conflicted_files } => {
            tracing::info!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                conflicted_files = conflicted_files.len(),
                "Pre-merge stopped with conflicts; dispatching agent with file list",
            );
            PreMergeAttempt::Conflicts {
                files: conflicted_files,
            }
        }
        PreMergeOutcome::AlreadyPrimed { conflicted_files } => {
            // The monitor's earlier transition-into-`conflicting` run already
            // primed the worktree with the same merge; reuse that state so
            // we don't re-fetch and don't drop into the classic "agent runs
            // fetch/merge" prompt on top of an existing `MERGE_HEAD` (PR #516
            // review).
            tracing::info!(
                workspace_id = %workspace.id,
                pr_url = %open_pr.pr_url,
                conflicted_files = conflicted_files.len(),
                "Pre-merge reusing already-primed merge from a prior run; dispatching agent with file list",
            );
            PreMergeAttempt::Conflicts {
                files: conflicted_files,
            }
        }
    }
}

pub async fn resolve_merge_conflicts_follow_up(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<(), ResolveMergeConflictsError>>, ApiError> {
    let pool = &deployment.db().pool;

    let prs = PullRequest::find_by_workspace_id(pool, workspace.id).await?;
    let open_pr = prs
        .into_iter()
        .find(|pr| matches!(pr.pr_status, MergeStatus::Open));

    let Some(open_pr) = open_pr else {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ResolveMergeConflictsError::NoPrAttached,
        )));
    };

    // Issue #370: attempt the merge server-side first. A clean merge skips the
    // agent entirely (stale GitHub mergeability rollup); real conflicts hand
    // the agent a merge-in-progress worktree + the file list; anything else
    // falls back to the classic prompt so the agent re-runs the merge itself.
    let target_branch = open_pr.target_branch_name.clone();
    let prompt = match attempt_pre_merge_for_pr(&deployment, &workspace, &open_pr).await {
        PreMergeAttempt::CleanAndPushed => {
            return Ok(ResponseJson(ApiResponse::success(())));
        }
        PreMergeAttempt::Conflicts { files } => {
            quick_action_prompts::format_resolve_merge_conflicts_prompt_with_conflicts(
                &target_branch,
                &files,
            )
        }
        PreMergeAttempt::Fallback => {
            quick_action_prompts::format_resolve_merge_conflicts_prompt(&target_branch)
        }
    };

    match dispatch_quick_action_follow_up(&deployment, &workspace, prompt).await? {
        QuickActionDispatchOutcome::Dispatched => Ok(ResponseJson(ApiResponse::success(()))),
        QuickActionDispatchOutcome::NoAgentSession => Ok(ResponseJson(
            ApiResponse::error_with_data(ResolveMergeConflictsError::NoAgentSession),
        )),
    }
}

/// Best-effort fetch of a PR's comment list for prompt enrichment. Returns
/// `None` on any failure (missing repo linkage, non-GitHub host, network
/// error) with a warn — enrichment is optional and callers must degrade to
/// the fallback prompt instead of blocking dispatch.
async fn fetch_pr_comments_for_prompt(
    deployment: &DeploymentImpl,
    open_pr: &PullRequest,
) -> Option<Vec<UnifiedPrComment>> {
    let pool = &deployment.db().pool;
    let repo_id = open_pr.repo_id?;
    let repo = match Repo::find_by_id(pool, repo_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "PR repo not found — dispatching without inline comments");
            return None;
        }
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to load repo for prompt enrichment: {e}");
            return None;
        }
    };
    let git = deployment.git();
    let remote = match git.resolve_remote_for_branch(&repo.path, &open_pr.target_branch_name) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to resolve remote for prompt enrichment: {e}");
            return None;
        }
    };
    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Unsupported host for prompt enrichment: {e}");
            return None;
        }
    };
    match git_host
        .get_pr_comments(&repo.path, &remote.url, open_pr.pr_number)
        .await
    {
        Ok(comments) => Some(comments),
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to fetch PR comments for prompt enrichment: {e}");
            None
        }
    }
}

/// Best-effort fetch of a PR's failing CI checks for prompt enrichment.
/// Returns `None` on any failure with a warn — same fallback contract as
/// [`fetch_pr_comments_for_prompt`].
async fn fetch_pr_failed_checks_for_prompt(
    deployment: &DeploymentImpl,
    open_pr: &PullRequest,
) -> Option<Vec<PrFailedCheck>> {
    let pool = &deployment.db().pool;
    let repo_id = open_pr.repo_id?;
    let repo = match Repo::find_by_id(pool, repo_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "PR repo not found — dispatching without inline checks");
            return None;
        }
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to load repo for prompt enrichment: {e}");
            return None;
        }
    };
    let git = deployment.git();
    let remote = match git.resolve_remote_for_branch(&repo.path, &open_pr.target_branch_name) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to resolve remote for prompt enrichment: {e}");
            return None;
        }
    };
    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Unsupported host for prompt enrichment: {e}");
            return None;
        }
    };
    match git_host.get_pr_failed_checks(&open_pr.pr_url).await {
        Ok(checks) => Some(checks),
        Err(e) => {
            tracing::warn!(pr_url = %open_pr.pr_url, "Failed to fetch failed checks for prompt enrichment: {e}");
            None
        }
    }
}

pub async fn address_pr_comments_follow_up(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<(), AddressPrCommentsError>>, ApiError> {
    let pool = &deployment.db().pool;

    let prs = PullRequest::find_by_workspace_id(pool, workspace.id).await?;
    let open_pr = prs
        .into_iter()
        .find(|pr| matches!(pr.pr_status, MergeStatus::Open));

    let Some(open_pr) = open_pr else {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            AddressPrCommentsError::NoPrAttached,
        )));
    };

    // Owner/repo is `Some` only when the PR URL is a recognizable GitHub PR
    // URL (parseable). For anything else (Azure DevOps, malformed URL) we
    // pass `None`: the formatter falls back to positional `gh` invocations
    // with `pr_url` instead of a broken `-R <full-url>` (PR #490 review).
    let owner_repo = quick_action_prompts::parse_owner_repo_from_pr_url(&open_pr.pr_url);

    // Best-effort enrichment: fetch inline comments so the agent doesn't have
    // to shell out. Any failure logs a warn and drops us into the fallback
    // prompt (which still tells the agent to fetch with `gh`).
    let comments = fetch_pr_comments_for_prompt(&deployment, &open_pr).await;
    let comments_block = comments.as_ref().and_then(|c| {
        quick_action_prompts::render_comments_block(
            c,
            quick_action_prompts::COMMENTS_BLOCK_MAX_BYTES,
        )
    });

    let prompt = quick_action_prompts::format_address_pr_comments_prompt(
        open_pr.pr_number,
        &open_pr.pr_url,
        owner_repo.as_deref(),
        comments_block.as_deref(),
    );

    match dispatch_quick_action_follow_up(&deployment, &workspace, prompt).await? {
        QuickActionDispatchOutcome::Dispatched => Ok(ResponseJson(ApiResponse::success(()))),
        QuickActionDispatchOutcome::NoAgentSession => Ok(ResponseJson(
            ApiResponse::error_with_data(AddressPrCommentsError::NoAgentSession),
        )),
    }
}

pub async fn fix_ci_follow_up(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<(), FixCiError>>, ApiError> {
    let pool = &deployment.db().pool;

    let prs = PullRequest::find_by_workspace_id(pool, workspace.id).await?;
    let open_pr = prs
        .into_iter()
        .find(|pr| matches!(pr.pr_status, MergeStatus::Open));

    let Some(open_pr) = open_pr else {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            FixCiError::NoPrAttached,
        )));
    };

    // See the twin comment in `address_pr_comments_follow_up`: `None` means
    // the URL was not a parseable GitHub PR URL, and the formatter falls
    // back to positional-URL `gh` invocations instead of a broken `-R`.
    let owner_repo = quick_action_prompts::parse_owner_repo_from_pr_url(&open_pr.pr_url);

    let failed_checks = fetch_pr_failed_checks_for_prompt(&deployment, &open_pr).await;
    let failed_checks_block = failed_checks.as_ref().and_then(|c| {
        quick_action_prompts::render_failed_checks_block(
            c,
            quick_action_prompts::FAILED_CHECKS_BLOCK_MAX_BYTES,
        )
    });

    let prompt = quick_action_prompts::format_fix_ci_prompt(
        open_pr.pr_number,
        &open_pr.pr_url,
        owner_repo.as_deref(),
        failed_checks_block.as_deref(),
    );

    match dispatch_quick_action_follow_up(&deployment, &workspace, prompt).await? {
        QuickActionDispatchOutcome::Dispatched => Ok(ResponseJson(ApiResponse::success(()))),
        QuickActionDispatchOutcome::NoAgentSession => Ok(ResponseJson(
            ApiResponse::error_with_data(FixCiError::NoAgentSession),
        )),
    }
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/", post(create_pr))
        .route("/attach", post(attach_existing_pr))
        .route("/comments", get(get_pr_comments))
        .route(
            "/resolve-merge-conflicts",
            post(resolve_merge_conflicts_follow_up),
        )
        .route("/address-pr-comments", post(address_pr_comments_follow_up))
        .route("/fix-ci", post(fix_ci_follow_up))
}
