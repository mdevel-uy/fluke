use db::models::{
    repo::{Repo, RepoError},
    requests::WorkspaceRepoInput,
    scratch_workspace::ScratchWorkspace,
    workspace::{Workspace, WorkspaceError},
};
use deployment::Deployment;
use services::services::{container::ContainerService, events::workspace_patch};
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, routes::workspaces::create::create_workspace_record};

/// Resolve (or lazily create) the scratch workspace for the given repository:
/// a worktree outside the fleet where the Director's mission sessions run.
///
/// One scratch workspace exists per repo (enforced by the `scratch_workspaces`
/// table). The worktree is provisioned on first call; subsequent calls reuse
/// it and re-materialise it via `ensure_container_exists` if it was cleaned
/// up in the meantime.
pub async fn ensure_scratch_workspace(
    deployment: &DeploymentImpl,
    repo_id: Uuid,
) -> Result<Workspace, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or_else(|| ApiError::from(RepoError::NotFound))?;

    if let Some(workspace_id) = ScratchWorkspace::find_workspace_id_for_repo(pool, repo_id).await? {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or(ApiError::Workspace(WorkspaceError::WorkspaceNotFound))?;

        materialize_scratch_workspace(deployment, &workspace, &repo).await?;
        retract_from_fleet_sidebar(deployment, workspace.id);
        return Ok(workspace);
    }

    let target_branch = resolve_target_branch(deployment, &repo).await?;
    let workspace_name = Some(format!("scratch: {}", repo.display_name));

    let workspace = create_workspace_record(deployment, workspace_name).await?;

    let mut managed_workspace = deployment
        .workspace_manager()
        .load_managed_workspace(workspace)
        .await?;

    managed_workspace
        .add_repository(
            &WorkspaceRepoInput {
                repo_id,
                target_branch,
            },
            deployment.git(),
        )
        .await
        .map_err(ApiError::from)?;

    let workspace_id = managed_workspace.workspace.id;

    if let Err(err) = ScratchWorkspace::create(pool, workspace_id, repo_id).await {
        // The scratch workspace couldn't be registered — best-effort cleanup so
        // we don't leak a task-less workspace whose worktree cleanup would still
        // be triggered by the periodic scan.
        if let Err(cleanup_err) = Workspace::delete(pool, workspace_id).await {
            tracing::warn!(
                "Failed to delete workspace {} after scratch registration error: {}",
                workspace_id,
                cleanup_err
            );
        }
        return Err(ApiError::Database(err));
    }

    materialize_scratch_workspace(deployment, &managed_workspace.workspace, &repo).await?;
    retract_from_fleet_sidebar(deployment, workspace_id);
    Ok(managed_workspace.workspace.clone())
}

/// The workspace INSERT (and the repo attachment) fire the live-events hook
/// before the `scratch_workspaces` registration exists, so those first patches
/// pass the `is_scratch` filter and the scratch workspace leaks into the fleet
/// sidebar as an idle agent — and since every later patch IS filtered, no
/// remove ever follows. Broadcast an explicit remove once the registration is
/// in place; clients ignore removes for keys they never saw, so this is safe
/// to send on every panel open and also heals already-connected clients.
fn retract_from_fleet_sidebar(deployment: &DeploymentImpl, workspace_id: Uuid) {
    deployment
        .events()
        .msg_store()
        .push_patch(workspace_patch::remove(workspace_id));
}

/// Materialize the scratch workspace's worktree, creating the workspace
/// branch when needed.
///
/// `ensure_container_exists` deliberately never creates workspace branches
/// (read paths must not be writers — see `WorkspaceBranchMissing`), so a
/// scratch workspace whose branch doesn't exist yet — never started, or the
/// branch was deleted — must go through `ContainerService::create`, which is
/// the one path allowed to materialize it. This endpoint owns the scratch
/// workspace, so it is legitimately a writer.
async fn materialize_scratch_workspace(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    repo: &Repo,
) -> Result<(), ApiError> {
    let branch_exists = deployment
        .git()
        .check_branch_exists(&repo.path, &workspace.branch)?;

    if branch_exists {
        deployment
            .container()
            .ensure_container_exists(workspace)
            .await?;
    } else {
        deployment.container().create(workspace).await?;
    }

    Ok(())
}

async fn resolve_target_branch(
    deployment: &DeploymentImpl,
    repo: &Repo,
) -> Result<String, ApiError> {
    if let Some(configured) = repo
        .default_target_branch
        .as_ref()
        .filter(|branch| !branch.is_empty())
    {
        return Ok(configured.clone());
    }

    if let Some(remote_default) = deployment.git().get_remote_default_branch(&repo.path) {
        return Ok(remote_default);
    }

    deployment
        .git()
        .get_current_branch(&repo.path)
        .map_err(|err| {
            ApiError::BadRequest(format!(
                "Unable to determine a target branch for repo '{}': {}",
                repo.display_name, err
            ))
        })
}
