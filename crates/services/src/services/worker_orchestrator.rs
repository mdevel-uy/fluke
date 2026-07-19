//! Worker orchestration: turn queued `worker_tasks` into running workspaces
//! and reconcile task state as their PRs move through review.
//!
//! State machine (per worker):
//!
//!   queued  ─▶  in_progress  ─▶  in_review  ─▶  done
//!                    │
//!                    └────────────────────────▶  failed  (agent crashed;
//!                                                          worker goes idle,
//!                                                          a human decides)
//!
//! Worker capacity check for taking a new task:
//!   * no `in_progress` task, AND
//!   * strictly less than `WORKER_MAX_IN_REVIEW` (default 2) `in_review` tasks,
//!   * at least one `queued` task.

use std::sync::Arc;

use db::{
    DBService,
    models::{
        repo::Repo,
        requests::WorkspaceRepoInput,
        worker::Worker,
        worker_task::{self, WorkerTask},
        workspace::{CreateWorkspace, Workspace},
    },
};
use executors::profile::ExecutorConfig;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{error, info, warn};
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::services::{
    config::Config,
    container::{ContainerError, ContainerService},
};

pub const DEFAULT_MAX_IN_REVIEW: i64 = 2;
pub const WORKER_MAX_IN_REVIEW_ENV: &str = "WORKER_MAX_IN_REVIEW";

/// Template for the final instruction appended to every worker task prompt.
/// `{target_branch}` is replaced with the repo's `default_target_branch`.
/// Kept short so operators can predict what the agent will do at the end
/// of a run.
pub const WORKER_FINAL_INSTRUCTION_TEMPLATE: &str = "\
When you finish the work above, commit your changes, push the branch to the \
remote, and open a pull request against `{target_branch}` using \
`gh pr create`. The PR body must describe the changes you made and reference \
any linked issue if applicable.";

#[derive(Debug, Error)]
pub enum StartError {
    #[error("worker not found")]
    WorkerNotFound,
    #[error("no queued tasks for worker")]
    NothingQueued,
    #[error("worker already has a task in progress")]
    AlreadyInProgress,
    #[error("worker has reached the in-review cap ({0})")]
    InReviewCapReached(i64),
    #[error("repo not found")]
    RepoNotFound,
    #[error("repo has no default_target_branch configured")]
    RepoMissingDefaultBranch,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Container(#[from] ContainerError),
    #[error(transparent)]
    Workspace(#[from] workspace_manager::WorkspaceError),
    #[error(transparent)]
    DbWorkspace(#[from] db::models::workspace::WorkspaceError),
}

impl StartError {
    /// Categorize preconditions that should surface as HTTP 409 to the API.
    pub fn is_conflict(&self) -> bool {
        matches!(
            self,
            StartError::NothingQueued
                | StartError::AlreadyInProgress
                | StartError::InReviewCapReached(_)
        )
    }
}

pub fn max_in_review_from_env() -> i64 {
    std::env::var(WORKER_MAX_IN_REVIEW_ENV)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(DEFAULT_MAX_IN_REVIEW)
}

pub struct StartedTask {
    pub task: WorkerTask,
    pub workspace_id: Uuid,
}

/// Attempt to take the next queued task for the worker. Returns `Ok(None)`
/// when nothing was taken because there were no queued tasks *and* no other
/// blocking preconditions applied — i.e. the caller should treat it as a
/// no-op rather than an error. Returns [`StartError::NothingQueued`] only
/// when the caller explicitly asked for a start.
pub async fn try_take_next(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    worker_id: Uuid,
) -> Result<StartedTask, StartError> {
    let pool = &db.pool;

    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or(StartError::WorkerNotFound)?;

    if WorkerTask::find_in_progress(pool, worker_id).await?.is_some() {
        return Err(StartError::AlreadyInProgress);
    }

    let cap = max_in_review_from_env();
    let in_review = WorkerTask::count_in_review(pool, worker_id).await?;
    if in_review >= cap {
        return Err(StartError::InReviewCapReached(cap));
    }

    let task = WorkerTask::find_next_queued(pool, worker_id)
        .await?
        .ok_or(StartError::NothingQueued)?;

    let repo = Repo::find_by_id(pool, task.repo_id)
        .await?
        .ok_or(StartError::RepoNotFound)?;

    let target_branch = repo
        .default_target_branch
        .clone()
        .filter(|b| !b.is_empty())
        .ok_or(StartError::RepoMissingDefaultBranch)?;

    let executor_config = config.read().await.executor_profile.clone();
    let executor_config: ExecutorConfig = executor_config.into();

    let workspace_manager = WorkspaceManager::new(db.clone());

    let workspace_id = Uuid::new_v4();
    let branch_label = task.title.as_str();
    let git_branch_name = container
        .git_branch_from_workspace(&workspace_id, branch_label)
        .await;

    let workspace_name = worker_workspace_name(&worker, &task);
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: git_branch_name,
            name: Some(workspace_name),
        },
        workspace_id,
    )
    .await?;

    // Attach the workspace to the worker + task in the DB *before* touching
    // the filesystem so that a partial failure still leaves an owned
    // workspace we can clean up.
    Worker::attach_workspace(pool, worker.id, workspace.id).await?;
    WorkerTask::set_workspace_id(pool, task.id, workspace.id).await?;

    let mut managed = workspace_manager
        .load_managed_workspace(workspace.clone())
        .await?;

    if let Err(e) = managed
        .add_repository(
            &WorkspaceRepoInput {
                repo_id: repo.id,
                target_branch: target_branch.clone(),
            },
            container.git(),
        )
        .await
    {
        // Could not attach the repo — the task was never really started.
        // Roll the task back to queued and surface the error so the caller
        // (endpoint or watcher) can decide what to do.
        let _ = WorkerTask::set_status(pool, task.id, worker_task::STATUS_QUEUED).await;
        return Err(e.into());
    }

    let prompt = build_worker_prompt(&worker.soul, &task.prompt, &target_branch);

    let task = WorkerTask::set_status(pool, task.id, worker_task::STATUS_IN_PROGRESS).await?;

    match container
        .start_workspace(&workspace, executor_config, prompt)
        .await
    {
        Ok(_process) => {
            info!(
                worker_id = %worker.id,
                task_id = %task.id,
                workspace_id = %workspace.id,
                "Worker started task"
            );
            Ok(StartedTask {
                task,
                workspace_id: workspace.id,
            })
        }
        Err(e) => {
            // Agent failed to start — per the design, the worker stays idle
            // (does NOT automatically pick up the next task).
            let failed = WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await;
            if let Err(e) = failed {
                warn!(
                    "Failed to mark worker task {} as failed after start error: {}",
                    task.id, e
                );
            }
            error!(
                worker_id = %worker.id,
                task_id = %task.id,
                "Worker task failed to start: {}",
                e
            );
            Err(e.into())
        }
    }
}

/// Reconcile a workspace PR transitioning to *open*: if the workspace
/// belongs to a worker and its linked task is `in_progress`, move the
/// task to `in_review`.
pub async fn on_pr_open(db: &DBService, workspace_id: Uuid) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(());
    };
    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(());
    };
    if task.worker_id != worker_id {
        return Ok(());
    }
    if task.status == worker_task::STATUS_IN_PROGRESS {
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_IN_REVIEW).await?;
        info!(
            worker_id = %worker_id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            "Worker task moved to in_review",
        );
    }
    Ok(())
}

/// Reconcile a workspace PR transitioning to *merged*: flip the linked
/// task to `done` and try to take the next queued task. Returns whether
/// a new task was started.
pub async fn on_pr_merged(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let pool = &db.pool;
    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(false);
    };
    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(false);
    };
    if task.worker_id != worker_id {
        return Ok(false);
    }
    if task.status != worker_task::STATUS_DONE {
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_DONE).await?;
        info!(
            worker_id = %worker_id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            "Worker task moved to done",
        );
    }

    match try_take_next(config, db, container, worker_id).await {
        Ok(_) => Ok(true),
        Err(e) if e.is_conflict() => Ok(false),
        Err(StartError::Sqlx(e)) => Err(e),
        Err(e) => {
            warn!(
                worker_id = %worker_id,
                "Failed to auto-take next task after merge: {}",
                e
            );
            Ok(false)
        }
    }
}

fn worker_workspace_name(worker: &Worker, task: &WorkerTask) -> String {
    let title = task.title.trim();
    if title.is_empty() {
        worker.name.clone()
    } else {
        format!("{} — {}", worker.name, title)
    }
}

fn build_worker_prompt(soul: &str, task_prompt: &str, target_branch: &str) -> String {
    let soul = soul.trim();
    let task_prompt = task_prompt.trim();
    let final_instruction =
        WORKER_FINAL_INSTRUCTION_TEMPLATE.replace("{target_branch}", target_branch);
    format!("{soul}\n\n---\n\n{task_prompt}\n\n---\n\n{final_instruction}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_prompt_with_soul_task_and_final_instruction() {
        let prompt = build_worker_prompt("  soul  ", "  do it  ", "main");
        assert!(prompt.starts_with("soul\n\n---\n\ndo it\n\n---\n\n"));
        assert!(prompt.contains("`main`"));
        assert!(prompt.contains("gh pr create"));
    }
}
