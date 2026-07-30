use axum::{
    extract::{Query, State},
    response::Json as ResponseJson,
};
use db::models::{
    repo::{Repo, RepoError},
    requests::WorkspaceRepoInput,
    workspace::{Workspace, WorkspaceContext},
};
use deployment::Deployment;
use serde::Deserialize;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl, error::ApiError, routes::workspaces::create::create_workspace_record,
};

#[derive(Debug, Deserialize)]
pub struct ScratchWorkspaceQuery {
    pub repo_id: Uuid,
}

/// Get or create the scratch workspace that hosts ad-hoc interactive sessions
/// for the given repo.
///
/// Scratch workspaces are per-repo and idempotent: repeated calls for the same
/// repo return the same workspace. The workspace's target branch defaults to
/// the repo's `default_target_branch`; if that isn't configured we surface a
/// bad request so the caller can guide the user to set it.
pub async fn get_or_create_scratch_workspace(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ScratchWorkspaceQuery>,
) -> Result<ResponseJson<ApiResponse<WorkspaceContext>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, query.repo_id)
        .await?
        .ok_or(ApiError::Repo(RepoError::NotFound))?;

    if let Some(existing) = Workspace::find_scratch_for_repo(pool, query.repo_id).await? {
        let context = Workspace::load_context(pool, existing.id).await?;
        return Ok(ResponseJson(ApiResponse::success(context)));
    }

    let target_branch = repo.default_target_branch.clone().ok_or_else(|| {
        ApiError::BadRequest(format!(
            "Repository '{}' has no default target branch configured; set one before opening an ad-hoc session.",
            repo.name
        ))
    })?;

    let workspace = create_workspace_record(
        &deployment,
        Some(format!("scratch: {}", repo.display_name)),
    )
    .await?;

    Workspace::mark_scratch(pool, workspace.id).await?;

    let mut managed = deployment
        .workspace_manager()
        .load_managed_workspace(workspace)
        .await?;

    if let Err(e) = managed
        .add_repository(
            &WorkspaceRepoInput {
                repo_id: repo.id,
                target_branch,
            },
            deployment.git(),
        )
        .await
    {
        // Roll back the workspace so we don't leave orphans behind if the
        // repository couldn't be attached (branch missing, etc.).
        if let Err(rollback_err) = Workspace::delete(pool, managed.workspace.id).await {
            tracing::warn!(
                workspace_id = %managed.workspace.id,
                "Failed to roll back scratch workspace after repo attach error: {}",
                rollback_err
            );
        }
        return Err(ApiError::from(e));
    }

    let context = Workspace::load_context(pool, managed.workspace.id).await?;

    deployment
        .track_if_analytics_allowed(
            "scratch_workspace_created",
            serde_json::json!({
                "workspace_id": context.workspace.id.to_string(),
                "repo_id": repo.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(context)))
}
