//! Worker orchestration: turn queued `worker_tasks` into running workspaces
//! and reconcile task state as their PRs move through review.
//!
//! State machine (per worker):
//!
//!   developer role:
//!     queued  ─▶  in_progress  ─▶  in_review  ─▶  done
//!                     │
//!                     └────────────────────────▶  failed  (agent crashed;
//!                                                           worker goes idle,
//!                                                           a human decides)
//!
//!   analyst / reviewer role:
//!     queued  ─▶  in_progress  ─▶  done   (agent finished OK)
//!                     │
//!                     └──────────────────────▶  failed  (agent crashed)
//!
//! A start attempt that fails *before* the agent begins running (missing
//! `default_target_branch`, unreachable target branch, workspace creation
//! error) is transactional: any workspace it created is archived and
//! detached from the worker, and the linked task stays `queued` so the
//! next start can retry it.
//!
//! Worker capacity check for taking a new task:
//!   * no `in_progress` task, AND
//!   * strictly less than `WORKER_MAX_IN_REVIEW` (default 2) `in_review` tasks,
//!   * at least one `queued` task.

use std::{path::PathBuf, sync::Arc};

use db::{
    DBService,
    models::{
        execution_process::{ExecutionProcess, ExecutionProcessRunReason},
        execution_process_repo_state::ExecutionProcessRepoState,
        pull_request::PullRequest,
        repo::Repo,
        requests::WorkspaceRepoInput,
        worker::{ROLE_DEVELOPER, Worker},
        worker_task::{self, CreateWorkerTask, WorkerTask},
        workspace::{CreateWorkspace, Workspace},
        workspace_repo::WorkspaceRepo,
    },
};
use executors::profile::ExecutorConfig;
use git_host::{CreatePrRequest, GitHostError, GitHostProvider, GitHostService};
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::services::{
    config::Config,
    container::{ContainerError, ContainerService},
};

pub const DEFAULT_MAX_IN_REVIEW: i64 = 2;
pub const WORKER_MAX_IN_REVIEW_ENV: &str = "WORKER_MAX_IN_REVIEW";

/// Final instruction for developer workers: commit and verify; the system
/// handles push and PR creation automatically on run completion.
pub const WORKER_FINAL_INSTRUCTION_TEMPLATE: &str = "\
When you finish the work above, commit your changes with clear messages and \
verify that `pnpm run check` (frontend) or `cargo check` (backend) passes. \
The system will push the branch and open the pull request against \
`{target_branch}` automatically once your run ends — do NOT create the PR \
yourself.";

/// Final instruction for analyst and reviewer workers: produce deliverables,
/// NOT a PR.
pub const NON_DEVELOPER_FINAL_INSTRUCTION: &str = "\
Your deliverable is the issues, plans, or reviews you created — NOT a pull \
request. Do NOT create any PR. When you finish, end with a concise summary of \
what you produced.";

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
    #[error("repo '{0}' has no default_target_branch configured")]
    RepoMissingDefaultBranch(String),
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

pub const WORKER_LEAD_ENABLED_ENV: &str = "WORKER_LEAD_ENABLED";
pub const WORKER_REVIEW_MAX_ROUNDS_ENV: &str = "WORKER_REVIEW_MAX_ROUNDS";
pub const DEFAULT_MAX_REVIEW_ROUNDS: i64 = 2;

pub fn lead_enabled_from_env() -> bool {
    std::env::var(WORKER_LEAD_ENABLED_ENV)
        .map(|v| v.to_ascii_lowercase() != "false" && v != "0")
        .unwrap_or(true)
}

pub fn review_max_rounds_from_env() -> i64 {
    std::env::var(WORKER_REVIEW_MAX_ROUNDS_ENV)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_MAX_REVIEW_ROUNDS)
}

pub struct StartedTask {
    pub task: WorkerTask,
    pub workspace_id: Uuid,
}

/// Attempt to take the next queued task for the worker. Returns
/// [`StartError::NothingQueued`] when the caller explicitly asked for a
/// start but no task was available.
///
/// The start is transactional: preconditions are validated up front so
/// nothing is created on a cheap-fail path (missing repo,
/// missing `default_target_branch`, etc.), and any failure *after* the
/// workspace is created rolls the workspace back (archived + detached
/// from the worker) so the worker is not blocked by a zombie. The linked
/// task only moves to `in_progress` — and only receives `workspace_id` —
/// when the agent has actually started.
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

    // Auto-repair orphan workspaces attached to this worker before applying
    // the capacity guard, so a previous failed start does not block the
    // worker forever (see issue #32).
    reconcile_worker_workspaces(db, worker_id).await?;

    if WorkerTask::find_in_progress(pool, worker_id)
        .await?
        .is_some()
    {
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

    // Cheap precondition: fail *before* creating any workspace so we do not
    // leak a zombie on a mis-configured repo (see issues #31 + #32).
    let target_branch = repo
        .default_target_branch
        .clone()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| StartError::RepoMissingDefaultBranch(repo.display_name.clone()))?;

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

    // Attach the workspace to the worker up front so `active_workspace_id`
    // reflects the busy state during setup. Any failure below rolls this
    // back via `rollback_workspace`.
    if let Err(e) = Worker::attach_workspace(pool, worker.id, workspace.id).await {
        rollback_workspace(db, workspace.id).await;
        return Err(e.into());
    }

    // Register the repo through the same workspace_manager path that the UI's
    // POST /api/workspaces/start uses — this writes workspace_repos and
    // validates the target branch exists. Without this the worktree can't
    // be created and the agent surfaces "Workspace has no repositories
    // configured" (see issue #33).
    let mut managed = match workspace_manager
        .load_managed_workspace(workspace.clone())
        .await
    {
        Ok(m) => m,
        Err(e) => {
            rollback_workspace(db, workspace.id).await;
            return Err(e.into());
        }
    };

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
        rollback_workspace(db, workspace.id).await;
        return Err(e.into());
    }

    let prompt = build_worker_prompt(&worker.soul, &task.prompt, &target_branch, &worker.role);

    // Actually start the agent. This creates the worktree and the coding
    // agent session. If it fails, roll the workspace back so the worker is
    // not stuck and the queued task can be retried.
    if let Err(e) = container
        .start_workspace(&workspace, executor_config, prompt)
        .await
    {
        rollback_workspace(db, workspace.id).await;
        error!(
            worker_id = %worker.id,
            task_id = %task.id,
            "Worker task failed to start: {}",
            e
        );
        return Err(e.into());
    }

    // Commit: only now, after the agent has started, do we link the task to
    // the workspace and flip it to in_progress. If a caller retries after
    // an earlier failure, they will still see this task as queued because
    // the previous attempt rolled back cleanly.
    if let Err(e) = WorkerTask::set_workspace_id(pool, task.id, workspace.id).await {
        // The agent is already running; we cannot safely tear it down.
        // Log loudly and surface the error so the operator can reconcile.
        error!(
            worker_id = %worker.id,
            task_id = %task.id,
            workspace_id = %workspace.id,
            "Worker task started but failed to link workspace_id: {}",
            e
        );
        return Err(e.into());
    }
    let task = WorkerTask::set_status(pool, task.id, worker_task::STATUS_IN_PROGRESS).await?;

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

/// Best-effort cleanup for a workspace whose start failed after it was
/// created. Archives the workspace, detaches it from any worker, and
/// clears any lingering worker_task -> workspace link so the worker's
/// capacity guard and the UI both see a clean slate on the next start.
///
/// Errors are logged but not surfaced: the caller is already returning
/// the underlying failure, and losing a cleanup step should never mask
/// the real error.
async fn rollback_workspace(db: &DBService, workspace_id: Uuid) {
    let pool = &db.pool;
    if let Err(e) = Workspace::set_archived(pool, workspace_id, true).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to archive workspace during rollback: {}",
            e
        );
    }
    if let Err(e) = Worker::detach_workspace(pool, workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to detach worker during rollback: {}",
            e
        );
    }
    if let Err(e) = WorkerTask::clear_workspace_link(pool, workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to clear worker_task link during rollback: {}",
            e
        );
    }
}

/// Auto-repair inconsistent worker state: any non-archived workspace that
/// is attached to `worker_id` but has no associated `in_progress` or
/// `in_review` task is treated as a zombie left behind by a previous
/// failed start. Archive it and detach it so it does not block the
/// capacity guard.
///
/// This is idempotent and safe to call before every start attempt.
pub(crate) async fn reconcile_worker_workspaces(
    db: &DBService,
    worker_id: Uuid,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    for ws_id in Worker::active_workspace_ids(pool, worker_id).await? {
        if WorkerTask::workspace_has_active_task(pool, ws_id).await? {
            continue;
        }
        warn!(
            worker_id = %worker_id,
            workspace_id = %ws_id,
            "Auto-repairing orphan workspace attached to worker with no active task"
        );
        if let Err(e) = Workspace::set_archived(pool, ws_id, true).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to archive orphan workspace during auto-repair: {}",
                e
            );
        }
        if let Err(e) = Worker::detach_workspace(pool, ws_id).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to detach orphan workspace during auto-repair: {}",
                e
            );
        }
        if let Err(e) = WorkerTask::clear_workspace_link(pool, ws_id).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to clear worker_task link during auto-repair: {}",
                e
            );
        }
    }
    Ok(())
}

/// Startup sweep: move every `in_progress` worker task that has no live
/// execution behind it out of the zombie state.
///
/// Must be called AFTER `cleanup_orphan_executions()` has already marked
/// stale `running` execution processes as `failed`, so that the running-
/// process check below reliably returns false for killed tasks.
///
/// Decision tree for each zombie task:
///   - No commits produced → re-queue at front (most common case: the
///     agent was killed by a deploy before it finished anything useful).
///   - Commits exist → mark as `failed` so a human can inspect and retry.
///
/// Safety rule: if the execution-state check itself errors, the task is
/// left untouched — a visible zombie is safer than accidentally killing a
/// live run.
pub async fn reconcile_in_progress_tasks(db: &DBService) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let in_progress = WorkerTask::find_all_in_progress(pool).await?;

    for task in in_progress {
        let Some(workspace_id) = task.workspace_id else {
            // In-progress without a workspace is an unexpected inconsistency.
            warn!(
                task_id = %task.id,
                worker_id = %task.worker_id,
                "in_progress worker task has no workspace_id — marking failed (startup recovery)"
            );
            if let Err(e) = WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await
            {
                warn!(
                    task_id = %task.id,
                    "Failed to mark no-workspace task as failed during startup recovery: {}",
                    e
                );
            }
            continue;
        };

        // Safety: skip if there is somehow still a live execution running.
        match ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            pool,
            workspace_id,
        )
        .await
        {
            Ok(true) => {
                warn!(
                    task_id = %task.id,
                    workspace_id = %workspace_id,
                    "in_progress worker task still has a running execution — leaving it alone (startup recovery)"
                );
                continue;
            }
            Err(e) => {
                warn!(
                    task_id = %task.id,
                    workspace_id = %workspace_id,
                    "Could not determine execution state during startup recovery — leaving task alone: {}",
                    e
                );
                continue;
            }
            Ok(false) => {}
        }

        // No live execution: zombie confirmed. Decide re-queue vs. failed.
        let has_commits =
            match ExecutionProcess::workspace_has_any_after_commit(pool, workspace_id).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        task_id = %task.id,
                        workspace_id = %workspace_id,
                        "Could not check commits during startup recovery — leaving task alone: {}",
                        e
                    );
                    continue;
                }
            };

        if has_commits {
            // Agent produced commits before being killed. Mark failed so a
            // human can inspect the workspace and decide whether to retry.
            match WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await {
                Ok(_) => info!(
                    task_id = %task.id,
                    worker_id = %task.worker_id,
                    workspace_id = %workspace_id,
                    "Zombie worker task had commits — marked as failed (restart recovery)"
                ),
                Err(e) => warn!(
                    task_id = %task.id,
                    "Failed to mark zombie task as failed during startup recovery: {}",
                    e
                ),
            }
        } else {
            // No commits: re-queue at the front so the task runs next time
            // the worker is started. Clean up the stale workspace so the
            // capacity guard sees a clear slot.
            match WorkerTask::re_queue_at_front(pool, task.id).await {
                Err(e) => {
                    warn!(
                        task_id = %task.id,
                        "Failed to re-queue zombie task during startup recovery: {}",
                        e
                    );
                    continue;
                }
                Ok(_) => {}
            }
            if let Err(e) = Workspace::set_archived(pool, workspace_id, true).await {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to archive workspace during startup recovery: {}",
                    e
                );
            }
            if let Err(e) = Worker::detach_workspace(pool, workspace_id).await {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to detach workspace during startup recovery: {}",
                    e
                );
            }
            info!(
                task_id = %task.id,
                worker_id = %task.worker_id,
                workspace_id = %workspace_id,
                "Zombie worker task had no commits — re-queued at front (restart recovery)"
            );
        }
    }
    Ok(())
}

/// Reconcile a workspace PR transitioning to *open*: if the workspace
/// belongs to a developer worker and its linked task is `in_progress`,
/// move the task to `in_review`.
///
/// Analyst and reviewer workspaces are not subject to PR-based lifecycle
/// transitions; if they open a PR by mistake, a warning is logged.
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

    // Check worker role — only developers follow the PR lifecycle.
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(());
    };
    if worker.role != ROLE_DEVELOPER {
        warn!(
            worker_id = %worker_id,
            workspace_id = %workspace_id,
            role = %worker.role,
            "Non-developer worker created a PR — pr_monitor will not adopt it"
        );
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
///
/// Analyst and reviewer workspaces are skipped with a warning if a PR
/// is somehow merged for them — their lifecycle is driven by
/// `on_agent_finished`, not by PRs.
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

    // Non-developer workers should not reach here; guard defensively.
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(false);
    };
    if worker.role != ROLE_DEVELOPER {
        warn!(
            worker_id = %worker_id,
            workspace_id = %workspace_id,
            role = %worker.role,
            "Non-developer worker PR merged — ignoring (lifecycle driven by on_agent_finished)"
        );
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

/// Reconcile a workspace whose coding-agent run just finished.
///
/// - **Developer workers**: push the branch, adopt or create the PR, then
///   transition the task to `in_review` via `on_pr_open`. On any failure
///   (dirty tree, no commits, push error, PR creation error) the task is
///   marked `failed` immediately — no silent swallowing.
/// - **Analyst / reviewer workers**: transition to `done` or `failed`,
///   archive the workspace, and attempt to auto-start the next queued task.
pub async fn on_agent_finished(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    succeeded: bool,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;

    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(());
    };
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(());
    };

    if worker.role == ROLE_DEVELOPER {
        return on_developer_agent_finished(config, db, container, workspace_id, &worker, succeeded)
            .await;
    }

    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(());
    };
    if task.worker_id != worker_id {
        return Ok(());
    }

    // Only transition tasks that are still in_progress.
    if task.status != worker_task::STATUS_IN_PROGRESS {
        return Ok(());
    }

    let new_status = if succeeded {
        worker_task::STATUS_DONE
    } else {
        worker_task::STATUS_FAILED
    };

    WorkerTask::set_status(pool, task.id, new_status).await?;
    info!(
        worker_id = %worker_id,
        task_id = %task.id,
        workspace_id = %workspace_id,
        role = %worker.role,
        succeeded,
        "Analyst/reviewer worker task finished — status set to {}",
        new_status
    );

    // Archive the workspace now that the task is complete.
    if let Err(e) = container.archive_workspace(workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to archive workspace after agent finished: {}",
            e
        );
    }

    // Auto-start the next queued task for this worker.
    if succeeded {
        match try_take_next(config, db, container, worker_id).await {
            Ok(_) => {}
            Err(e) if e.is_conflict() => {}
            Err(StartError::Sqlx(e)) => {
                warn!(
                    worker_id = %worker_id,
                    "Failed to auto-take next task after agent finished: {}",
                    e
                );
            }
            Err(e) => {
                warn!(
                    worker_id = %worker_id,
                    "Failed to auto-take next task after agent finished: {}",
                    e
                );
            }
        }
    }

    Ok(())
}

/// Handle a developer worker's agent run completing: push the branch, adopt
/// or create a PR, and transition the task to `in_review`. Any failure
/// (dirty tree, no commits, push error, PR creation error) marks the task
/// `failed` so the human can see the cause and retry.
async fn on_developer_agent_finished(
    _config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    worker: &Worker,
    succeeded: bool,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;

    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(());
    };
    if task.worker_id != worker.id {
        return Ok(());
    }
    if task.status != worker_task::STATUS_IN_PROGRESS {
        return Ok(());
    }

    if !succeeded {
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        info!(
            worker_id = %worker.id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            "Developer worker task failed — agent did not complete successfully"
        );
        if let Err(e) = container.archive_workspace(workspace_id).await {
            warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
        }
        return Ok(());
    }

    // --- agent succeeded: push branch and create PR ---

    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        warn!(workspace_id = %workspace_id, "Workspace not found after agent finished");
        return Ok(());
    };

    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace_id).await?;
    let Some(workspace_repo) = workspace_repos.into_iter().next() else {
        warn!(workspace_id = %workspace_id, "Developer workspace has no repos — marking failed");
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        return Ok(());
    };

    let Some(repo) = Repo::find_by_id(pool, workspace_repo.repo_id).await? else {
        warn!(workspace_id = %workspace_id, "Workspace repo record not found — marking failed");
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        return Ok(());
    };

    let Some(container_ref) = workspace.container_ref.as_ref() else {
        warn!(workspace_id = %workspace_id, "Workspace has no container_ref — marking failed");
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        return Ok(());
    };

    let worktree_path = PathBuf::from(container_ref).join(&repo.name);
    let git = container.git();

    // Fail fast if the agent left uncommitted changes.
    match git.is_worktree_clean(&worktree_path) {
        Ok(false) => {
            warn!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "Developer task ended with uncommitted changes — marking failed"
            );
            WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
            if let Err(e) = container.archive_workspace(workspace_id).await {
                warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
            }
            return Ok(());
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "Could not check worktree clean status: {}", e);
        }
        Ok(true) => {}
    }

    // Fail fast if the agent produced no commits above the target branch.
    // Compare current HEAD to the before_head_commit recorded when the
    // execution process started; if identical the agent did nothing useful.
    let no_commits = check_no_new_commits(db, git, workspace_id, &worktree_path).await;
    if no_commits {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task.id,
            "Developer task ended with no new commits — marking failed"
        );
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        if let Err(e) = container.archive_workspace(workspace_id).await {
            warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
        }
        return Ok(());
    }

    // Idempotency: if a PR is already recorded (agent created it via gh cli
    // and the pr_monitor already adopted it), just ensure the task is in_review.
    match PullRequest::find_by_workspace_id(pool, workspace_id).await {
        Ok(prs) if !prs.is_empty() => {
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "PR already recorded for workspace — triggering on_pr_open"
            );
            return on_pr_open(db, workspace_id).await;
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "Could not query existing PRs: {}", e);
        }
        Ok(_) => {}
    }

    // Push the branch. A push failure is terminal for this run (no retry loop
    // per the spec); the human sees the cause on the card and can retry.
    if let Err(e) = git.push_to_remote(&worktree_path, &workspace.branch, false) {
        error!(
            workspace_id = %workspace_id,
            task_id = %task.id,
            "Failed to push branch '{}': {}",
            workspace.branch,
            e
        );
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
        if let Err(e) = container.archive_workspace(workspace_id).await {
            warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
        }
        return Ok(());
    }
    info!(
        workspace_id = %workspace_id,
        task_id = %task.id,
        branch = %workspace.branch,
        "Branch pushed successfully"
    );

    // Resolve push remote and base branch.
    let push_remote = match git.resolve_remote_for_branch(&repo.path, &workspace.branch) {
        Ok(r) => r,
        Err(e) => {
            error!(workspace_id = %workspace_id, "Could not resolve remote: {}", e);
            WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
            if let Err(e) = container.archive_workspace(workspace_id).await {
                warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
            }
            return Ok(());
        }
    };

    let target_branch_ref = &workspace_repo.target_branch;
    let (target_remote, base_branch) =
        match git.get_remote_from_branch_name(&repo.path, target_branch_ref) {
            Ok(remote) => {
                let branch = target_branch_ref
                    .strip_prefix(&format!("{}/", remote.name))
                    .unwrap_or(target_branch_ref);
                (remote, branch.to_string())
            }
            Err(_) => (push_remote.clone(), target_branch_ref.clone()),
        };

    let git_host = match GitHostService::from_url(&target_remote.url) {
        Ok(h) => h,
        Err(GitHostError::UnsupportedProvider) => {
            error!(workspace_id = %workspace_id, "Unsupported git provider for URL '{}'", target_remote.url);
            WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
            if let Err(e) = container.archive_workspace(workspace_id).await {
                warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
            }
            return Ok(());
        }
        Err(e) => {
            error!(workspace_id = %workspace_id, "Failed to create GitHostService: {}", e);
            WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
            if let Err(e) = container.archive_workspace(workspace_id).await {
                warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
            }
            return Ok(());
        }
    };

    // Adoption: check if the agent already created a PR via `gh pr create`.
    match git_host
        .list_prs_for_branch(&repo.path, &target_remote.url, &workspace.branch)
        .await
    {
        Ok(prs) if !prs.is_empty() => {
            let pr = &prs[0];
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace_id,
                workspace_repo.repo_id,
                &base_branch,
                pr.number,
                &pr.url,
            )
            .await
            {
                warn!(workspace_id = %workspace_id, "Failed to record adopted PR locally: {}", e);
            }
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                pr_number = pr.number,
                "Adopted existing PR — triggering on_pr_open"
            );
            return on_pr_open(db, workspace_id).await;
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "PR list check failed (proceeding to create): {}", e);
        }
        Ok(_) => {}
    }

    // Create the PR programmatically. Retry once on transient failures.
    let pr_body = build_pr_body(&task);
    let pr_request = CreatePrRequest {
        title: task.title.clone(),
        body: Some(pr_body),
        head_branch: workspace.branch.clone(),
        base_branch: base_branch.clone(),
        draft: None,
        head_repo_url: Some(push_remote.url.clone()),
    };

    let pr_result = match git_host
        .create_pr(&repo.path, &target_remote.url, &pr_request)
        .await
    {
        Ok(info) => Ok(info),
        Err(first_err) => {
            warn!(
                workspace_id = %workspace_id,
                "First PR creation attempt failed ({}); retrying once",
                first_err
            );
            git_host
                .create_pr(&repo.path, &target_remote.url, &pr_request)
                .await
        }
    };

    match pr_result {
        Ok(pr_info) => {
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace_id,
                workspace_repo.repo_id,
                &base_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            {
                warn!(workspace_id = %workspace_id, "Failed to record new PR locally: {}", e);
            }
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                pr_number = pr_info.number,
                "PR created — triggering on_pr_open"
            );
            on_pr_open(db, workspace_id).await
        }
        Err(e) => {
            // "already exists" is a recoverable edge-case: adopt instead.
            if let GitHostError::PullRequest(ref msg) = e {
                if msg.to_ascii_lowercase().contains("already exists") {
                    if let Ok(prs) = git_host
                        .list_prs_for_branch(&repo.path, &target_remote.url, &workspace.branch)
                        .await
                    {
                        if let Some(pr) = prs.into_iter().next() {
                            PullRequest::create_for_workspace(
                                pool,
                                workspace_id,
                                workspace_repo.repo_id,
                                &base_branch,
                                pr.number,
                                &pr.url,
                            )
                            .await
                            .ok();
                            info!(
                                workspace_id = %workspace_id,
                                task_id = %task.id,
                                pr_number = pr.number,
                                "PR already existed; adopted — triggering on_pr_open"
                            );
                            return on_pr_open(db, workspace_id).await;
                        }
                    }
                }
            }
            error!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "PR creation failed after retry: {}",
                e
            );
            WorkerTask::set_status(pool, task.id, worker_task::STATUS_FAILED).await?;
            if let Err(archive_err) = container.archive_workspace(workspace_id).await {
                warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", archive_err);
            }
            Ok(())
        }
    }
}

/// Returns `true` when the current HEAD in `worktree_path` matches the
/// `before_head_commit` that was recorded when the latest CodingAgent
/// execution started — meaning the agent made no commits at all.
///
/// When the comparison cannot be performed (no execution record, no
/// before_head_commit, or git error), returns `false` so the caller does
/// not block a legitimate run on a best-effort check.
async fn check_no_new_commits(
    db: &DBService,
    git: &git::GitService,
    workspace_id: Uuid,
    worktree_path: &PathBuf,
) -> bool {
    let pool = &db.pool;

    let ep = match ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace_id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await
    {
        Ok(Some(ep)) => ep,
        _ => return false,
    };

    let repo_states =
        match ExecutionProcessRepoState::find_by_execution_process_id(pool, ep.id).await {
            Ok(s) => s,
            Err(_) => return false,
        };

    let Some(before_oid) = repo_states.into_iter().find_map(|s| s.before_head_commit) else {
        return false;
    };

    match git.get_head_info(worktree_path) {
        Ok(head) => head.oid == before_oid,
        Err(_) => false,
    }
}

/// Build a PR body from a worker task: includes the task prompt and, when
/// an issue number is present, a "Closes #N" line.
fn build_pr_body(task: &WorkerTask) -> String {
    let mut body = task.prompt.trim().to_string();
    if let Some(issue) = task.issue_number {
        body.push_str(&format!("\n\nCloses #{issue}"));
    }
    body
}

/// Dispatch a review task to the first reviewer worker for the given PR.
///
/// No-op (with debug/warn logging) when:
/// - `WORKER_LEAD_ENABLED=false`
/// - No reviewer worker is registered
/// - The reviewer is the same worker as the PR author (no self-review)
/// - An active reviewer task already exists for this PR (idempotent guard)
/// - The PR has already reached the `WORKER_REVIEW_MAX_ROUNDS` cap (escalated)
pub async fn dispatch_review_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    pr_title: &str,
    repo_id: Uuid,
    author_worker_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    if !lead_enabled_from_env() {
        return Ok(());
    }

    let pool = &db.pool;

    let Some(reviewer) = Worker::find_first_reviewer(pool).await? else {
        debug!(
            pr_number,
            "No reviewer worker found — skipping review dispatch"
        );
        return Ok(());
    };

    if let Some(author_id) = author_worker_id {
        if reviewer.id == author_id {
            debug!(
                reviewer_id = %reviewer.id,
                pr_number,
                "Reviewer is the same as PR author — skipping self-review"
            );
            return Ok(());
        }
    }

    if WorkerTask::find_active_reviewer_task_for_pr(pool, pr_number, repo_id)
        .await?
        .is_some()
    {
        debug!(
            pr_number,
            "Active reviewer task already exists for PR — skipping duplicate dispatch"
        );
        return Ok(());
    }

    let max_rounds = review_max_rounds_from_env();
    let rounds = WorkerTask::count_reviewer_tasks_for_pr(pool, pr_number, repo_id).await?;
    if rounds >= max_rounds {
        warn!(
            pr_number,
            rounds,
            max_rounds,
            "PR #{} has reached the maximum review rounds ({}/{}) — escalated, human review required",
            pr_number,
            rounds,
            max_rounds,
        );
        return Ok(());
    }

    let task_title = format!("Review PR #{}: {}", pr_number, pr_title);
    let task_prompt = format!(
        "Revisá el PR #{pr_number} según tu checklist. \
         Usá `gh pr view {pr_number}`, `gh pr diff {pr_number}` y \
         `gh pr checkout {pr_number}` para examinar los cambios. \
         Cuando termines: si aprobás, ejecutá \
         `gh pr review {pr_number} --approve`; si pedís cambios, ejecutá \
         `gh pr review {pr_number} --request-changes -b '<razón>'`."
    );

    let task = WorkerTask::append(
        pool,
        reviewer.id,
        &CreateWorkerTask {
            repo_id,
            title: task_title,
            prompt: task_prompt,
            issue_number: Some(pr_number),
            skills: Vec::new(),
        },
    )
    .await?;

    info!(
        reviewer_id = %reviewer.id,
        pr_number,
        task_id = %task.id,
        round = rounds + 1,
        "Dispatched review task for PR #{} (round {}/{})",
        pr_number,
        rounds + 1,
        max_rounds,
    );

    match try_take_next(config, db, container, reviewer.id).await {
        Ok(_) => info!(reviewer_id = %reviewer.id, "Reviewer worker started on review task"),
        Err(e) if e.is_conflict() => {}
        Err(StartError::Sqlx(e)) => return Err(e),
        Err(e) => warn!(
            reviewer_id = %reviewer.id,
            "Failed to auto-start reviewer after dispatch: {}",
            e
        ),
    }

    Ok(())
}

/// Dispatch a fix task to the PR author worker when a reviewer requests changes.
///
/// No-op when:
/// - `WORKER_LEAD_ENABLED=false`
/// - The author already has an active fix task for this PR (idempotent guard)
pub async fn dispatch_author_fix_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    repo_id: Uuid,
    author_worker_id: Uuid,
) -> Result<(), sqlx::Error> {
    if !lead_enabled_from_env() {
        return Ok(());
    }

    let pool = &db.pool;

    // Guard: dispatch a fix task only when more review rounds have COMPLETED
    // than fix tasks have been dispatched. This prevents re-dispatching every
    // poll cycle while the GitHub review state still shows "changes_requested"
    // after the author has already pushed a fix.
    let completed_reviews =
        WorkerTask::count_reviewer_tasks_done_for_pr(pool, pr_number, repo_id).await?;
    if completed_reviews == 0 {
        debug!(
            pr_number,
            "No completed reviewer task yet — skipping fix dispatch"
        );
        return Ok(());
    }
    let dispatched_fixes =
        WorkerTask::count_all_author_fix_tasks_for_pr(pool, author_worker_id, pr_number, repo_id)
            .await?;
    if dispatched_fixes >= completed_reviews {
        debug!(
            pr_number,
            author_worker_id = %author_worker_id,
            fixes = dispatched_fixes,
            reviews = completed_reviews,
            "Author fix already dispatched for current review round — skipping"
        );
        return Ok(());
    }

    let task_title = format!("Atendé el review del PR #{}", pr_number);
    let task_prompt = format!(
        "El reviewer solicitó cambios en el PR #{pr_number}. \
         Revisá los comentarios con `gh pr view {pr_number} --comments`. \
         Para hacer los cambios: ejecutá `gh pr checkout {pr_number}` para posicionarte \
         en el branch correcto, corregí los issues señalados por el reviewer, \
         y pusheá con `git push`. El PR ya existe — NO crees uno nuevo."
    );

    let task = WorkerTask::append(
        pool,
        author_worker_id,
        &CreateWorkerTask {
            repo_id,
            title: task_title,
            prompt: task_prompt,
            issue_number: Some(pr_number),
            skills: Vec::new(),
        },
    )
    .await?;

    info!(
        author_worker_id = %author_worker_id,
        pr_number,
        task_id = %task.id,
        "Dispatched author fix task for PR #{}",
        pr_number,
    );

    match try_take_next(config, db, container, author_worker_id).await {
        Ok(_) => info!(
            author_worker_id = %author_worker_id,
            "Author worker started on fix task"
        ),
        Err(e) if e.is_conflict() => {}
        Err(StartError::Sqlx(e)) => return Err(e),
        Err(e) => warn!(
            author_worker_id = %author_worker_id,
            "Failed to auto-start author after fix dispatch: {}",
            e
        ),
    }

    Ok(())
}

fn worker_workspace_name(worker: &Worker, task: &WorkerTask) -> String {
    let title = task.title.trim();
    if title.is_empty() {
        worker.name.clone()
    } else {
        format!("{} — {}", worker.name, title)
    }
}

fn build_worker_prompt(soul: &str, task_prompt: &str, target_branch: &str, role: &str) -> String {
    let base = crate::services::base_instructions::effective_base_instructions();
    let soul = soul.trim();
    let task_prompt = task_prompt.trim();
    let final_instruction = if role == ROLE_DEVELOPER {
        WORKER_FINAL_INSTRUCTION_TEMPLATE.replace("{target_branch}", target_branch)
    } else {
        NON_DEVELOPER_FINAL_INSTRUCTION.to_string()
    };
    format!(
        "[SYSTEM BASE INSTRUCTIONS — these take precedence over the worker soul in any conflict]\n\n\
         {base}\n\n\
         ---\n\n\
         [WORKER SOUL]\n\n\
         {soul}\n\n\
         ---\n\n\
         {task_prompt}\n\n\
         ---\n\n\
         {final_instruction}"
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use db::models::{repo::Repo, worker::CreateWorker, worker_task::CreateWorkerTask};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn builds_prompt_with_base_instructions_soul_task_and_final_instruction() {
        let prompt = build_worker_prompt("  soul  ", "  do it  ", "main", ROLE_DEVELOPER);
        // Base instructions come first
        assert!(prompt.starts_with("[SYSTEM BASE INSTRUCTIONS"));
        // All sections are present
        assert!(prompt.contains("[WORKER SOUL]"));
        assert!(prompt.contains("soul"));
        assert!(prompt.contains("do it"));
        assert!(prompt.contains("`main`"));
        // System now handles push/PR; agent must NOT be told to use gh pr create
        assert!(!prompt.contains("gh pr create"), "developer prompt must not instruct agent to create PR");
        assert!(prompt.contains("do NOT create the PR"));
        // Base instructions precede the soul
        let base_pos = prompt.find("[SYSTEM BASE INSTRUCTIONS").unwrap();
        let soul_pos = prompt.find("[WORKER SOUL]").unwrap();
        let task_pos = prompt.find("do it").unwrap();
        assert!(base_pos < soul_pos);
        assert!(soul_pos < task_pos);
    }

    #[test]
    fn builds_prompt_without_pr_instruction_for_analyst() {
        let prompt = build_worker_prompt("soul", "do it", "main", db::models::worker::ROLE_ANALYST);
        assert!(!prompt.contains("gh pr create"));
        assert!(prompt.contains("Do NOT create any PR"));
    }

    #[test]
    fn builds_prompt_without_pr_instruction_for_reviewer() {
        let prompt =
            build_worker_prompt("soul", "do it", "main", db::models::worker::ROLE_REVIEWER);
        assert!(!prompt.contains("gh pr create"));
        assert!(prompt.contains("Do NOT create any PR"));
    }

    async fn setup_test_db() -> DBService {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("open pool");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        DBService { pool }
    }

    async fn insert_repo(db: &DBService, name: &str) -> (Repo, TempDir) {
        let temp = TempDir::new().expect("tempdir");
        let path: PathBuf = temp.path().join(name);
        std::fs::create_dir_all(&path).expect("mkdir");
        let repo = Repo::find_or_create(&db.pool, &path, name)
            .await
            .expect("insert repo");
        (repo, temp)
    }

    async fn insert_worker(db: &DBService, name: &str) -> Worker {
        Worker::create(
            &db.pool,
            &CreateWorker {
                name: name.to_string(),
                emoji: "🤖".to_string(),
                soul: "test soul".to_string(),
                role: None,
            },
        )
        .await
        .expect("insert worker")
    }

    async fn insert_workspace(db: &DBService) -> Workspace {
        Workspace::create(
            &db.pool,
            &CreateWorkspace {
                branch: format!("test-branch-{}", Uuid::new_v4()),
                name: Some("test workspace".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect("insert workspace")
    }

    #[tokio::test]
    async fn reconcile_archives_orphan_workspace_attached_to_worker() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "wall-e").await;
        let workspace = insert_workspace(&db).await;

        // Simulate the zombie state: workspace attached to worker, no active
        // worker_task pointing at it, not archived.
        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();

        assert_eq!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap(),
            vec![workspace.id]
        );

        reconcile_worker_workspaces(&db, worker.id).await.unwrap();

        // Workspace should now be archived and detached — capacity guard
        // sees a clean slate.
        assert!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap()
                .is_empty()
        );
        let refreshed = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(refreshed.archived, "workspace should be archived");
    }

    #[tokio::test]
    async fn reconcile_leaves_workspace_with_active_task_alone() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "eve").await;
        let (repo, _repo_tmp) = insert_repo(&db, "eve-repo").await;
        let workspace = insert_workspace(&db).await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "wire it up".to_string(),
                prompt: "do the thing".to_string(),
                issue_number: None,
                skills: Vec::new(),
            },
        )
        .await
        .unwrap();

        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_workspace_id(&db.pool, task.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_IN_PROGRESS)
            .await
            .unwrap();

        reconcile_worker_workspaces(&db, worker.id).await.unwrap();

        // Healthy workspace with in_progress task must not be touched.
        assert_eq!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap(),
            vec![workspace.id]
        );
        let refreshed = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(
            !refreshed.archived,
            "healthy workspace must not be archived"
        );
    }

    #[tokio::test]
    async fn rollback_workspace_archives_detaches_and_clears_task_link() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "burn-e").await;
        let (repo, _repo_tmp) = insert_repo(&db, "burn-repo").await;
        let workspace = insert_workspace(&db).await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "cleanup".to_string(),
                prompt: "clean".to_string(),
                issue_number: None,
                skills: Vec::new(),
            },
        )
        .await
        .unwrap();

        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_workspace_id(&db.pool, task.id, workspace.id)
            .await
            .unwrap();

        rollback_workspace(&db, workspace.id).await;

        let refreshed_ws = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(refreshed_ws.archived, "workspace should be archived");
        assert!(
            Worker::find_by_workspace_id(&db.pool, workspace.id)
                .await
                .unwrap()
                .is_none(),
            "worker link should be cleared",
        );

        let refreshed_task = WorkerTask::find_by_id(&db.pool, task.id)
            .await
            .unwrap()
            .expect("task still exists");
        assert!(
            refreshed_task.workspace_id.is_none(),
            "task workspace_id should be cleared",
        );
    }

    #[tokio::test]
    async fn rollback_survives_reruns_when_workspace_missing() {
        // Rollback is best-effort: a caller that runs it twice, or against
        // a workspace that no longer exists in the DB, must not panic.
        let db = setup_test_db().await;
        rollback_workspace(&db, Uuid::new_v4()).await;
    }
}
