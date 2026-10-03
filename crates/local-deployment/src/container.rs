use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::anyhow;
use async_trait::async_trait;
use command_group::AsyncGroupChild;
use db::{
    DBService,
    models::{
        coding_agent_turn::CodingAgentTurn,
        execution_process::{
            ExecutionContext, ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus,
        },
        execution_process_repo_state::ExecutionProcessRepoState,
        pull_request::PullRequest,
        repo::Repo,
        review_round::ReviewRound,
        scratch::{DraftFollowUpData, Scratch, ScratchType},
        session::{Session, SessionError},
        worker_task::WorkerTask,
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use deployment::DeploymentError;
use executors::{
    actions::{
        Executable, ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    approvals::{ExecutorApprovalService, NoopExecutorApprovalService},
    env::{ExecutionEnv, RepoContext},
    executors::{BaseCodingAgent, CancellationToken, ExecutorExitResult, ExecutorExitSignal},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::GitService;
use serde_json::json;
use services::services::{
    analytics::AnalyticsContext,
    approvals::{Approvals, executor_approvals::ExecutorApprovalBridge},
    concurrency::ConcurrencySemaphore,
    config::Config,
    container::{ContainerError, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    file::FileService,
    notification::NotificationService,
    queued_message::QueuedMessageService,
    remote_client::RemoteClient,
    remote_sync,
    web_push::WebPushService,
};
use tokio::{sync::RwLock, task::JoinHandle};
use tokio_util::io::ReaderStream;
use utils::{
    log_msg::LogMsg,
    msg_store::MsgStore,
    text::{git_branch_id, short_uuid, truncate_to_char_boundary},
};
use uuid::Uuid;
use workspace_manager::{RepoWorkspaceInput, WorkspaceError, WorkspaceManager};

use crate::{command, copy};

const WORKSPACE_TOUCH_DEBOUNCE: Duration = Duration::from_mins(2);

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    workspace_manager: WorkspaceManager,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    cancellation_tokens: Arc<RwLock<HashMap<Uuid, CancellationToken>>>,
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    /// Tracks background tasks that stream logs to the database.
    /// When stopping execution, we await these to ensure logs are fully persisted.
    db_stream_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    exit_monitor_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    workspace_touch_times: Arc<RwLock<HashMap<Uuid, Instant>>>,
    config: Arc<RwLock<Config>>,
    git: GitService,
    file_service: FileService,
    analytics: Option<AnalyticsContext>,
    approvals: Approvals,
    queued_message_service: QueuedMessageService,
    notification_service: NotificationService,
    /// Optional Web Push sender (issue #533). `None` cuando el bootstrap de
    /// VAPID falla (asset dir RO, JSON corrupto) — el resto sigue andando.
    web_push: Option<WebPushService>,
    remote_client: Option<RemoteClient>,
    /// Gates concurrent coding-agent spawns and holds the FIFO wait
    /// queue. Only `CodingAgent` runs are gated — other run reasons
    /// (setup/cleanup/archive scripts, dev servers) bypass this and
    /// spawn immediately.
    concurrency: ConcurrencySemaphore,
}

impl LocalContainerService {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        db: DBService,
        workspace_manager: WorkspaceManager,
        msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
        config: Arc<RwLock<Config>>,
        git: GitService,
        file_service: FileService,
        analytics: Option<AnalyticsContext>,
        approvals: Approvals,
        queued_message_service: QueuedMessageService,
        remote_client: Option<RemoteClient>,
        web_push: Option<WebPushService>,
    ) -> Self {
        let child_store = Arc::new(RwLock::new(HashMap::new()));
        let cancellation_tokens = Arc::new(RwLock::new(HashMap::new()));
        let db_stream_handles = Arc::new(RwLock::new(HashMap::new()));
        let exit_monitor_handles = Arc::new(RwLock::new(HashMap::new()));
        let workspace_touch_times = Arc::new(RwLock::new(HashMap::new()));
        let notification_service = NotificationService::new(config.clone());
        let concurrency = ConcurrencySemaphore::new(config.clone());

        let container = LocalContainerService {
            db,
            workspace_manager,
            child_store,
            cancellation_tokens,
            msg_stores,
            db_stream_handles,
            exit_monitor_handles,
            workspace_touch_times,
            config,
            git,
            file_service,
            analytics,
            approvals,
            queued_message_service,
            notification_service,
            web_push,
            remote_client,
            concurrency,
        };

        container.spawn_workspace_cleanup();
        container.spawn_zombie_sweep();

        // If the server previously died with rows still in `queued` status,
        // hydrate the in-memory semaphore queue and try to drain it so no
        // task is lost across restarts. Runs in the background so `new` stays
        // non-blocking.
        {
            let container = container.clone();
            tokio::spawn(async move {
                container.recover_concurrency_queue().await;
            });
        }

        container
    }

    fn map_workspace_manager_error(err: WorkspaceError) -> ContainerError {
        match err {
            WorkspaceError::Database(err) => ContainerError::Sqlx(err),
            WorkspaceError::Worktree(err) => ContainerError::Worktree(err),
            WorkspaceError::GitService(err) => ContainerError::GitServiceError(err),
            WorkspaceError::Io(err) => ContainerError::Io(err),
            WorkspaceError::NoRepositories => {
                ContainerError::Other(anyhow!("No repositories provided"))
            }
            WorkspaceError::Repo(err) => ContainerError::Other(anyhow!(err)),
            WorkspaceError::WorkspaceNotFound => {
                ContainerError::Other(anyhow!("Workspace not found"))
            }
            WorkspaceError::RepoAlreadyAttached => {
                ContainerError::Other(anyhow!("Repository already attached to workspace"))
            }
            WorkspaceError::BranchNotFound { repo_name, branch } => ContainerError::Other(anyhow!(
                "Branch '{}' does not exist in repository '{}'",
                branch,
                repo_name
            )),
            WorkspaceError::WorkspaceBranchMissing { repo_name, branch } => {
                ContainerError::Other(anyhow!(
                    "Workspace branch '{}' does not exist in repository '{}' — the workspace has not been materialized yet",
                    branch,
                    repo_name
                ))
            }
            WorkspaceError::PartialCreation(msg) => ContainerError::Other(anyhow!(msg)),
        }
    }

    async fn workspace_repo_inputs(
        &self,
        workspace_id: Uuid,
    ) -> Result<(Vec<Repo>, Vec<RepoWorkspaceInput>), ContainerError> {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await?;
        if workspace_repos.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace_id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().ok_or_else(|| {
                    ContainerError::Other(anyhow!(
                        "Missing target branch mapping for repo {} in workspace {}",
                        repo.id,
                        workspace_id
                    ))
                })?;
                Ok(RepoWorkspaceInput::new(repo.clone(), target_branch))
            })
            .collect::<Result<_, ContainerError>>()?;

        Ok((repositories, workspace_inputs))
    }

    /// Populate `starting_point` on any repo input whose linked worker task
    /// targets an existing PR (fix-task on the author's PR, or a reviewer
    /// task). Fetches `pull/N/head` and pins the resolved SHA so
    /// `create_workspace` anchors the new workspace branch on the PR head
    /// instead of the target branch — the agent then finds a worktree
    /// already positioned on the code it needs to work on, with no
    /// `git fetch`/`reset --hard` in the prompt.
    ///
    /// The two flows resolve the anchor SHA differently:
    /// - **Reviewer task**: `ReviewRound::head_sha` is the commit the server
    ///   will submit the verdict against. We anchor on that exact commit,
    ///   NOT the current tip of `pull/N/head` — the author may push between
    ///   dispatch and materialization, and reviewing a different commit
    ///   than the one the verdict names would be a lie.
    /// - **Fix-task (author remediation)**: no round is bound to the task,
    ///   so we anchor on the current tip. The finish handler will push
    ///   the local branch back to the PR head with a fast-forward, so
    ///   starting from the tip is what allows the push to succeed.
    ///
    /// Runs only inside `create()` (not `ensure_container_exists`) so
    /// re-creation of an existing workspace preserves whatever state its
    /// branch happens to have.
    ///
    /// Any failure — task lookup, PR not found, fetch failure, pinned SHA
    /// missing after the fetch (force-push) — bubbles up as
    /// `ContainerError`. The caller rolls the workspace back through the
    /// existing sad-path (`worker_orchestrator::rollback_workspace` +
    /// `release_task_claim`) so no partially-materialized worktree survives.
    async fn with_pr_head_starting_points(
        &self,
        workspace_id: Uuid,
        mut inputs: Vec<RepoWorkspaceInput>,
    ) -> Result<Vec<RepoWorkspaceInput>, ContainerError> {
        let Some(task) = WorkerTask::find_by_workspace(&self.db.pool, workspace_id).await? else {
            return Ok(inputs);
        };

        // A task with a start_ref (fluke v2, #687) starts from that branch:
        // the developer of a TDD issue continues on QA's tests.
        if let Some(start_ref) = WorkerTask::start_ref(&self.db.pool, task.id).await? {
            for input in inputs.iter_mut() {
                let repo_path = input.repo.path.clone();
                let git = self.git.clone();
                let branch = start_ref.clone();
                let sha =
                    tokio::task::spawn_blocking(move || git.fetch_branch_tip(&repo_path, &branch))
                        .await
                        .map_err(|e| {
                            ContainerError::Other(anyhow!("fetch_branch_tip join error: {e}"))
                        })?
                        .map_err(|e| {
                            ContainerError::Other(anyhow!(
                                "No pude traer la rama {start_ref} (repo {}): {e}",
                                input.repo.name
                            ))
                        })?;
                tracing::info!(workspace_id = %workspace_id, start_ref = %start_ref, sha = %sha, "Anchoring workspace branch on start_ref");
                input.starting_point = Some(sha);
            }
            return Ok(inputs);
        }

        let Some(pr_number) = task.issue_number else {
            return Ok(inputs);
        };

        // Reviewer tasks pin the SHA at dispatch time (spec §A2). Using the
        // current tip of pull/N/head would desync the reviewed commit from
        // the commit the server submits the verdict against.
        let pinned_sha = ReviewRound::find_by_task_id(&self.db.pool, task.id)
            .await?
            .map(|round| round.head_sha);

        for input in inputs.iter_mut() {
            let pr =
                match PullRequest::find_by_repo_and_number(&self.db.pool, input.repo.id, pr_number)
                    .await?
                {
                    Some(pr) => pr,
                    // `issue_number` may point at a plain GitHub issue in this
                    // repo — there's no PR to anchor to, so leave the input alone.
                    None => continue,
                };

            let repo_path = input.repo.path.clone();
            let repo_name = input.repo.name.clone();
            let git = self.git.clone();
            let pinned = pinned_sha.clone();
            let sha = tokio::task::spawn_blocking(move || {
                git.fetch_pr_head(&repo_path, pr_number, pinned.as_deref())
            })
            .await
            .map_err(|e| {
                ContainerError::Other(anyhow!(
                    "fetch_pr_head join error for PR #{pr_number} in repo {repo_name}: {e}",
                ))
            })?
            .map_err(|e| {
                ContainerError::Other(anyhow!(
                    "No pude traer pull/{pr_number}/head del PR {} (repo {repo_name}): {e}",
                    pr.pr_url,
                ))
            })?;

            tracing::info!(
                workspace_id = %workspace_id,
                pr_number,
                repo = %repo_name,
                sha = %sha,
                pinned = pinned_sha.is_some(),
                "Anchoring workspace branch on PR head"
            );
            input.starting_point = Some(sha);
        }

        Ok(inputs)
    }

    async fn get_child_from_store(&self, id: &Uuid) -> Option<Arc<RwLock<AsyncGroupChild>>> {
        let map = self.child_store.read().await;
        map.get(id).cloned()
    }

    async fn add_child_to_store(&self, id: Uuid, exec: AsyncGroupChild) {
        let mut map = self.child_store.write().await;
        map.insert(id, Arc::new(RwLock::new(exec)));
    }

    async fn remove_child_from_store(&self, id: &Uuid) {
        let mut map = self.child_store.write().await;
        map.remove(id);
    }

    async fn add_cancellation_token(&self, id: Uuid, token: CancellationToken) {
        let mut map = self.cancellation_tokens.write().await;
        map.insert(id, token);
    }

    async fn take_cancellation_token(&self, id: &Uuid) -> Option<CancellationToken> {
        let mut map = self.cancellation_tokens.write().await;
        map.remove(id)
    }

    async fn add_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.db_stream_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.db_stream_handles.write().await;
        map.remove(id)
    }

    async fn add_exit_monitor_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.exit_monitor_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_exit_monitor_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.exit_monitor_handles.write().await;
        map.remove(id)
    }

    async fn cleanup_workspace(&self, workspace: &Workspace) {
        let Some(container_ref) = &workspace.container_ref else {
            return;
        };
        let workspace_dir = PathBuf::from(container_ref);

        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id)
            .await
            .unwrap_or_default();

        if repositories.is_empty() {
            tracing::warn!(
                "No repositories found for workspace {}, cleaning up workspace directory only",
                workspace.id
            );
            if workspace_dir.exists()
                && let Err(e) = tokio::fs::remove_dir_all(&workspace_dir).await
            {
                tracing::warn!("Failed to remove workspace directory: {}", e);
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(
                        "Failed to clean up workspace for workspace {}: {}",
                        workspace.id,
                        e
                    );
                });
        }

        let _ = Workspace::mark_worktree_deleted(&self.db.pool, workspace.id).await;
    }

    async fn cleanup_expired_workspaces(&self) -> Result<(), DeploymentError> {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            tracing::info!(
                "Expired workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return Ok(());
        }

        let expired_workspaces = Workspace::find_expired_for_cleanup(&self.db.pool).await?;
        if expired_workspaces.is_empty() {
            tracing::debug!("No expired workspaces found");
            return Ok(());
        }
        tracing::info!(
            "Found {} expired workspaces to clean up",
            expired_workspaces.len()
        );
        for workspace in &expired_workspaces {
            self.cleanup_workspace(workspace).await;
        }
        Ok(())
    }

    fn spawn_workspace_cleanup(&self) {
        let container = self.clone();
        tokio::spawn(async move {
            container
                .workspace_manager
                .cleanup_orphan_workspaces()
                .await;

            let mut cleanup_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(1800)); // 30 minutes
            loop {
                cleanup_interval.tick().await;
                tracing::info!("Starting periodic workspace cleanup...");
                container
                    .cleanup_expired_workspaces()
                    .await
                    .unwrap_or_else(|e| {
                        tracing::error!("Failed to clean up expired workspaces: {}", e)
                    });
            }
        });
    }

    /// Grace window before the sweep considers a `running` row with no
    /// child in the in-memory store to be a zombie. This must comfortably
    /// exceed the executor spawn timeout (30s) so the small window between
    /// `ExecutionProcess::create` and `add_child_to_store` is never treated
    /// as a leak.
    const ZOMBIE_GRACE_SECS: i64 = 120;
    const ZOMBIE_SWEEP_INTERVAL_SECS: u64 = 300; // 5 minutes

    /// Periodically finalise rows that are marked `running` but whose child
    /// process no longer lives in memory. Complements startup reconciliation
    /// (`cleanup_orphan_executions`) which only runs once at boot: this sweep
    /// catches leaks that happen while the server stays up — a `stop_execution`
    /// that raced with the exit monitor, a failed `update_completion` on the
    /// exit path, or any future path that fails to finalise the row.
    ///
    /// Without a sweep, a single stuck row blocks worktree cleanup forever
    /// (`Workspace::find_expired_for_cleanup` excludes workspaces with running
    /// execution processes), pollutes the reconciliation of in-progress tasks,
    /// and inflates the running-agents metric.
    fn spawn_zombie_sweep(&self) {
        let container = self.clone();
        tokio::spawn(async move {
            // Give startup reconciliation a head start so we do not double-work
            // on rows it is already handling.
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(
                Self::ZOMBIE_SWEEP_INTERVAL_SECS,
            ));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                container.sweep_zombie_execution_processes().await;
            }
        });
    }

    async fn sweep_zombie_execution_processes(&self) {
        let running = match ExecutionProcess::find_running(&self.db.pool).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("Zombie sweep: failed to list running processes: {}", e);
                return;
            }
        };
        if running.is_empty() {
            return;
        }

        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        for process in running {
            // Grace window guards the transient state where a row is
            // `running` in the DB but the child has not yet been inserted
            // into the store (spawn in progress, up to a 30s timeout).
            let age_secs = now_secs - process.started_at.timestamp();
            if age_secs < Self::ZOMBIE_GRACE_SECS {
                continue;
            }

            if self.get_child_from_store(&process.id).await.is_some() {
                continue;
            }

            // No child in memory → this row is a zombie. Decide the terminal
            // status based on whether the workspace still exists / is archived.
            let workspace_archived =
                match Session::find_by_id(&self.db.pool, process.session_id).await {
                    Ok(Some(session)) => {
                        match Workspace::find_by_id(&self.db.pool, session.workspace_id).await {
                            Ok(Some(ws)) => Some(ws.archived),
                            Ok(None) => None,
                            Err(e) => {
                                tracing::warn!(
                                    "Zombie sweep: failed to load workspace for process {}: {}",
                                    process.id,
                                    e
                                );
                                continue;
                            }
                        }
                    }
                    Ok(None) => None,
                    Err(e) => {
                        tracing::warn!(
                            "Zombie sweep: failed to load session for process {}: {}",
                            process.id,
                            e
                        );
                        continue;
                    }
                };

            let terminal_status = if matches!(workspace_archived, Some(true)) {
                // Row belongs to an archived workspace: the operator wanted
                // it stopped. Treat this as an explicit kill so downstream
                // metrics do not count it as an executor failure.
                ExecutionProcessStatus::Killed
            } else {
                ExecutionProcessStatus::Failed
            };

            tracing::warn!(
                "Zombie sweep: finalising running process {} (age {}s, workspace_archived={:?}) as {:?}",
                process.id,
                age_secs,
                workspace_archived,
                terminal_status
            );

            // Reuse stop_execution: after the idempotent fix it handles the
            // "no child" case and takes care of msg_store / semaphore /
            // queue draining so the sweep does not need to duplicate that.
            if let Err(e) = self.stop_execution(&process, terminal_status.clone()).await {
                tracing::warn!(
                    "Zombie sweep: stop_execution failed for {}: {}. Falling back to direct completion update.",
                    process.id,
                    e
                );
                if let Err(e2) = ExecutionProcess::update_completion(
                    &self.db.pool,
                    process.id,
                    terminal_status,
                    None,
                )
                .await
                {
                    tracing::error!(
                        "Zombie sweep: failed to finalise process {} even via fallback: {}",
                        process.id,
                        e2
                    );
                }
            }
        }
    }

    /// Record the current HEAD commit for each repository as the "after" state.
    /// Errors are silently ignored since this runs after the main execution completes
    /// and failure should not block process finalization.
    async fn update_after_head_commits(&self, exec_id: Uuid) {
        if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, exec_id).await {
            let workspace_root = self.workspace_to_current_dir(&ctx.workspace);
            for repo in &ctx.repos {
                let repo_path = workspace_root.join(&repo.name);
                if let Ok(head) = self.git().get_head_info(&repo_path) {
                    let _ = ExecutionProcessRepoState::update_after_head_commit(
                        &self.db.pool,
                        exec_id,
                        repo.id,
                        &head.oid,
                    )
                    .await;
                }
            }
        }
    }

    /// Get the commit message based on the execution run reason.
    async fn get_commit_message(&self, ctx: &ExecutionContext) -> String {
        match ctx.execution_process.run_reason {
            ExecutionProcessRunReason::CodingAgent => {
                // Try to retrieve the task summary from the coding agent turn
                // otherwise fallback to default message
                match CodingAgentTurn::find_by_execution_process_id(
                    &self.db().pool,
                    ctx.execution_process.id,
                )
                .await
                {
                    Ok(Some(turn)) if turn.summary.is_some() => turn.summary.unwrap(),
                    Ok(_) => {
                        tracing::debug!(
                            "No summary found for execution process {}, using default message",
                            ctx.execution_process.id
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Failed to retrieve summary for execution process {}: {}",
                            ctx.execution_process.id,
                            e
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                }
            }
            ExecutionProcessRunReason::CleanupScript => {
                format!("Cleanup script changes for workspace {}", ctx.workspace.id)
            }
            _ => format!(
                "Changes from execution process {}",
                ctx.execution_process.id
            ),
        }
    }

    /// Check which repos have uncommitted changes. Fails if any repo is inaccessible.
    fn check_repos_for_changes(
        &self,
        workspace_root: &Path,
        repos: &[Repo],
    ) -> Result<Vec<(Repo, PathBuf)>, ContainerError> {
        let git = GitService::new();
        let mut repos_with_changes = Vec::new();

        for repo in repos {
            let worktree_path = workspace_root.join(&repo.name);

            match git.get_worktree_status(&worktree_path) {
                Ok(ws) if !ws.entries.is_empty() => {
                    repos_with_changes.push((repo.clone(), worktree_path));
                }
                Ok(_) => {
                    tracing::debug!("No changes in repo '{}'", repo.name);
                }
                Err(e) => {
                    return Err(ContainerError::Other(anyhow!(
                        "Pre-flight check failed for repo '{}': {}",
                        repo.name,
                        e
                    )));
                }
            }
        }

        Ok(repos_with_changes)
    }

    async fn has_commits_from_execution(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<bool, ContainerError> {
        let workspace_root = self.workspace_to_current_dir(&ctx.workspace);

        let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(
            &self.db.pool,
            ctx.execution_process.id,
        )
        .await?;

        for repo in &ctx.repos {
            let repo_path = workspace_root.join(&repo.name);
            let current_head = self.git().get_head_info(&repo_path).ok().map(|h| h.oid);

            let before_head = repo_states
                .iter()
                .find(|s| s.repo_id == repo.id)
                .and_then(|s| s.before_head_commit.clone());

            if current_head != before_head {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Commit changes to each repo. Logs failures but continues with other repos.
    fn commit_repos(&self, repos_with_changes: Vec<(Repo, PathBuf)>, message: &str) -> bool {
        let mut any_committed = false;

        for (repo, worktree_path) in repos_with_changes {
            tracing::debug!(
                "Committing changes for repo '{}' at {:?}",
                repo.name,
                &worktree_path
            );

            match self.git().commit(&worktree_path, message) {
                Ok(true) => {
                    any_committed = true;
                    tracing::info!("Committed changes in repo '{}'", repo.name);
                }
                Ok(false) => {
                    tracing::warn!("No changes committed in repo '{}' (unexpected)", repo.name);
                }
                Err(e) => {
                    tracing::warn!("Failed to commit in repo '{}': {}", repo.name, e);
                }
            }
        }

        any_committed
    }

    /// Spawn a background task that polls the child process for completion and
    /// cleans up the execution entry when it exits.
    fn spawn_exit_monitor(
        &self,
        exec_id: &Uuid,
        exit_signal: Option<ExecutorExitSignal>,
    ) -> JoinHandle<()> {
        let exec_id = *exec_id;
        let child_store = self.child_store.clone();
        let msg_stores = self.msg_stores.clone();
        let db = self.db.clone();
        let config = self.config.clone();
        let container = self.clone();
        let analytics = self.analytics.clone();

        let mut process_exit_rx = self.spawn_os_exit_watcher(exec_id);

        tokio::spawn(async move {
            let mut exit_signal_future = exit_signal
                .map(|rx| rx.boxed()) // wait for result
                .unwrap_or_else(|| std::future::pending().boxed()); // no signal, stall forever

            let status_result: std::io::Result<std::process::ExitStatus>;

            // Wait for process to exit, or exit signal from executor
            tokio::select! {
                // Exit signal with result.
                // Some coding agent processes do not automatically exit after processing the user request; instead the executor
                // signals when processing has finished to gracefully kill the process.
                exit_result = &mut exit_signal_future => {
                    // Executor signaled completion: kill group and use the provided result
                    if let Some(child_lock) = child_store.read().await.get(&exec_id).cloned() {
                        let mut child = child_lock.write().await ;
                        if let Err(err) = command::kill_process_group(&mut child).await {
                            tracing::error!("Failed to kill process group after exit signal: {} {}", exec_id, err);
                        }
                    }

                    // Map the exit result to appropriate exit status
                    status_result = match exit_result {
                        Ok(ExecutorExitResult::Success) => Ok(success_exit_status()),
                        Ok(ExecutorExitResult::Failure) => Ok(failure_exit_status()),
                        Err(_) => Ok(success_exit_status()), // Channel closed, assume success
                    };
                }
                // Process exit
                exit_status_result = &mut process_exit_rx => {
                    status_result = exit_status_result.unwrap_or_else(|e| Err(std::io::Error::other(e)));
                }
            }

            let (exit_code, status) = match status_result {
                Ok(exit_status) => {
                    let code = exit_status.code().unwrap_or(-1) as i64;
                    let status = if exit_status.success() {
                        ExecutionProcessStatus::Completed
                    } else {
                        ExecutionProcessStatus::Failed
                    };
                    (Some(code), status)
                }
                Err(_) => (None, ExecutionProcessStatus::Failed),
            };

            if !ExecutionProcess::was_stopped(&db.pool, exec_id).await
                && let Err(e) =
                    ExecutionProcess::update_completion(&db.pool, exec_id, status, exit_code).await
            {
                tracing::error!("Failed to update execution process completion: {}", e);
            }

            // Persist the LLM usage captured by the executor before we tear
            // down the msg_store — the store may live longer than this scope,
            // but keeping the extraction adjacent to `update_completion`
            // keeps the "cost recorded" invariant tied to "process closed".
            persist_execution_process_usage(&db, &msg_stores, exec_id).await;

            if let Ok(ctx) = ExecutionProcess::load_context(&db.pool, exec_id).await {
                // Update executor session summary if available
                if let Err(e) = container.update_executor_session_summary(&exec_id).await {
                    tracing::warn!("Failed to update executor session summary: {}", e);
                }

                let success = matches!(
                    ctx.execution_process.status,
                    ExecutionProcessStatus::Completed
                ) && exit_code == Some(0);

                let cleanup_done = matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CleanupScript
                ) && !matches!(
                    ctx.execution_process.status,
                    ExecutionProcessStatus::Running
                );

                let mut already_finalized = false;

                if success || cleanup_done {
                    // Commit changes (if any) and get feedback about whether changes were made
                    let changes_committed = match container.try_commit_changes(&ctx).await {
                        Ok(committed) => committed,
                        Err(e) => {
                            tracing::error!("Failed to commit changes after execution: {}", e);
                            // Treat commit failures as if changes were made to be safe
                            true
                        }
                    };

                    let should_start_next = if matches!(
                        ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    ) {
                        // Check if agent made commits OR if we just committed uncommitted changes
                        changes_committed
                            || container
                                .has_commits_from_execution(&ctx)
                                .await
                                .unwrap_or(false)
                    } else {
                        true
                    };

                    if should_start_next {
                        // If the process exited successfully, start the next action
                        if let Err(e) = container.try_start_next_action(&ctx).await {
                            tracing::error!("Failed to start next action after completion: {}", e);
                        }
                    } else {
                        tracing::info!(
                            "Skipping cleanup script for workspace {} - no changes made by coding agent",
                            ctx.workspace.id
                        );

                        // Manually finalize task since we're bypassing normal execution flow
                        container.finalize_task(&ctx).await;
                        already_finalized = true;
                    }
                }

                if !already_finalized && container.should_finalize(&ctx) {
                    let has_chained_follow_up = ctx
                        .execution_process
                        .executor_action()
                        .ok()
                        .and_then(|action| action.next_action())
                        .is_some();
                    let mut started_queued_follow_up = false;

                    // Only execute queued messages if the execution succeeded
                    // If it failed or was killed, just clear the queue and finalize
                    let should_execute_queued = !matches!(
                        ctx.execution_process.status,
                        ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
                    );

                    if let Some(queued_msg) =
                        container.queued_message_service.take_queued(ctx.session.id)
                    {
                        if should_execute_queued {
                            tracing::info!(
                                "Found queued message for session {}, starting follow-up execution",
                                ctx.session.id
                            );

                            // Delete the scratch since we're consuming the queued message
                            if let Err(e) = Scratch::delete(
                                &db.pool,
                                ctx.session.id,
                                &ScratchType::DraftFollowUp,
                            )
                            .await
                            {
                                tracing::warn!(
                                    "Failed to delete scratch after consuming queued message: {}",
                                    e
                                );
                            }

                            // Execute the queued follow-up
                            if let Err(e) = container
                                .start_queued_follow_up(&ctx, &queued_msg.data)
                                .await
                            {
                                tracing::error!("Failed to start queued follow-up: {}", e);
                                // Fall back to finalization if follow-up fails
                                container.finalize_task(&ctx).await;
                            } else {
                                started_queued_follow_up = true;
                            }
                        } else {
                            // Execution failed or was killed - discard the queued message and finalize
                            tracing::info!(
                                "Discarding queued message for session {} due to execution status {:?}",
                                ctx.session.id,
                                ctx.execution_process.status
                            );
                            container.finalize_task(&ctx).await;
                        }
                    } else {
                        container.finalize_task(&ctx).await;
                    }

                    let should_mark_turn_unseen = matches!(
                        ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    ) && !has_chained_follow_up
                        && !started_queued_follow_up;

                    if should_mark_turn_unseen
                        && let Err(e) = CodingAgentTurn::mark_unseen_by_execution_process_id(
                            &db.pool,
                            ctx.execution_process.id,
                        )
                        .await
                    {
                        tracing::warn!(
                            "Failed to mark coding agent turn unseen for execution {}: {}",
                            ctx.execution_process.id,
                            e
                        );
                    }
                }

                // When a parallel setup script finishes and no coding agent is running,
                // consume any queued message that was stuck waiting
                if matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::SetupScript
                ) && !container.should_finalize(&ctx)
                {
                    let has_running_agent = ExecutionProcess::has_running_coding_agent_for_session(
                        &db.pool,
                        ctx.session.id,
                    )
                    .await
                    .unwrap_or(true);

                    if !has_running_agent
                        && let Some(queued_msg) =
                            container.queued_message_service.take_queued(ctx.session.id)
                    {
                        tracing::info!(
                            "Parallel setup script finished with queued message for session {}, starting follow-up",
                            ctx.session.id
                        );

                        if let Err(e) =
                            Scratch::delete(&db.pool, ctx.session.id, &ScratchType::DraftFollowUp)
                                .await
                        {
                            tracing::warn!(
                                "Failed to delete scratch after consuming queued message: {}",
                                e
                            );
                        }

                        if let Err(e) = container
                            .start_queued_follow_up(&ctx, &queued_msg.data)
                            .await
                        {
                            tracing::error!(
                                "Failed to start queued follow-up from setup script completion: {}",
                                e
                            );
                        }
                    }
                }

                // Fire analytics event when CodingAgent execution has finished
                if config.read().await.analytics_enabled
                    && matches!(
                        &ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    )
                    && let Some(analytics) = &analytics
                {
                    analytics.analytics_service.track_event(&analytics.user_id, "task_attempt_finished", Some(json!({
                        "workspace_id": ctx.workspace.id.to_string(),
                        "session_id": ctx.session.id.to_string(),
                        "execution_success": matches!(ctx.execution_process.status, ExecutionProcessStatus::Completed),
                        "exit_code": ctx.execution_process.exit_code,
                    })));
                }

                // Sync workspace to remote after CodingAgent execution
                if matches!(
                    &ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CodingAgent
                ) && let Some(client) = &container.remote_client
                {
                    let stats = diff_stream::compute_diff_stats(
                        &container.db.pool,
                        &container.git,
                        &ctx.workspace,
                    )
                    .await;
                    let workspace_name =
                        Workspace::find_by_id_with_status(&container.db.pool, ctx.workspace.id)
                            .await
                            .ok()
                            .flatten()
                            .and_then(|ws| ws.workspace.name);
                    let client = client.clone();
                    let workspace_id = ctx.workspace.id;
                    let archived = ctx.workspace.archived;
                    tokio::spawn(async move {
                        remote_sync::sync_workspace_to_remote(
                            &client,
                            workspace_id,
                            workspace_name.map(Some),
                            Some(archived),
                            stats.as_ref(),
                        )
                        .await;
                    });
                }
            }

            // Now that commit/next-action/finalization steps for this process are complete,
            // capture the HEAD OID as the definitive "after" state (best-effort).
            container.update_after_head_commits(exec_id).await;

            // Wait for DB persistence to complete before cleaning up MsgStore
            let db_stream_handle = container.take_db_stream_handle(&exec_id).await;
            if let Some(msg_arc) = msg_stores.write().await.remove(&exec_id) {
                msg_arc.push_finished();
            }
            if let Some(handle) = db_stream_handle {
                let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
            }

            // SIGKILL any orphaned children (e.g. MCP servers) still in the
            // process group. The executor itself is already done — either it
            // exited naturally or was killed in the exit-signal branch above.
            if let Some(child_lock) = child_store.read().await.get(&exec_id).cloned() {
                let mut child = child_lock.write().await;
                let _ = child.start_kill();
            }
            child_store.write().await.remove(&exec_id);

            // Release the concurrency slot this exec was holding (if any)
            // and hand the freed slot to the oldest queued execution.
            container.concurrency.release(&exec_id).await;
            container.drain_concurrency_queue().await;
        })
    }

    fn spawn_os_exit_watcher(
        &self,
        exec_id: Uuid,
    ) -> tokio::sync::oneshot::Receiver<std::io::Result<std::process::ExitStatus>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<std::io::Result<std::process::ExitStatus>>();
        let child_store = self.child_store.clone();
        tokio::spawn(async move {
            loop {
                let child_lock = {
                    let map = child_store.read().await;
                    map.get(&exec_id).cloned()
                };
                if let Some(child_lock) = child_lock {
                    let mut child_handler = child_lock.write().await;
                    match child_handler.try_wait() {
                        Ok(Some(status)) => {
                            let _ = tx.send(Ok(status));
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                } else {
                    let _ = tx.send(Err(io::Error::other(format!(
                        "Child handle missing for {exec_id}"
                    ))));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        rx
    }

    fn dir_name_from_workspace(workspace_id: &Uuid, task_title: &str) -> String {
        let task_title_id = git_branch_id(task_title);
        format!("{}-{}", short_uuid(workspace_id), task_title_id)
    }

    async fn track_child_msgs_in_store(
        &self,
        id: Uuid,
        child: &mut AsyncGroupChild,
    ) -> Result<(), ContainerError> {
        let store = self
            .get_msg_store_by_id(&id)
            .await
            .ok_or_else(|| ContainerError::Other(anyhow!("MsgStore not found for execution")))?;
        let out = child.inner().stdout.take().expect("no stdout");
        let err = child.inner().stderr.take().expect("no stderr");

        // Map stdout bytes -> LogMsg::Stdout
        let out = ReaderStream::new(out)
            .map_ok(|chunk| LogMsg::Stdout(String::from_utf8_lossy(&chunk).into_owned()));

        // Map stderr bytes -> LogMsg::Stderr
        let err = ReaderStream::new(err)
            .map_ok(|chunk| LogMsg::Stderr(String::from_utf8_lossy(&chunk).into_owned()));

        // If you have a JSON Patch source, map it to LogMsg::JsonPatch too, then select all three.

        // Merge and forward into the store
        let merged = select(out, err); // Stream<Item = Result<LogMsg, io::Error>>
        store.clone().spawn_forwarder(merged);
        Ok(())
    }

    /// Create a live diff log stream for ongoing attempts for WebSocket
    /// Returns a stream that owns the filesystem watcher - when dropped, watcher is cleaned up
    async fn create_live_diff_stream(
        &self,
        args: diff_stream::DiffStreamArgs,
    ) -> Result<DiffStreamHandle, ContainerError> {
        diff_stream::create(args)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("{e}")))
    }

    /// Extract the last assistant message from the MsgStore history
    fn extract_last_assistant_message(&self, exec_id: &Uuid) -> Option<String> {
        // Get the MsgStore for this execution
        let msg_stores = self.msg_stores.try_read().ok()?;
        let msg_store = msg_stores.get(exec_id)?;

        // Scan the history in reverse *in place*: cloning it (`get_history()`)
        // duplicates up to 100 MB of messages just to read the last entry.
        msg_store.find_map_history_rev(|msg| {
            let LogMsg::JsonPatch(patch) = msg else {
                return None;
            };
            // Try to extract a NormalizedEntry from the patch
            let (_, entry) = extract_normalized_entry_from_patch(patch)?;
            if !matches!(entry.entry_type, NormalizedEntryType::AssistantMessage) {
                return None;
            }
            let content = entry.content.trim();
            if content.is_empty() {
                return None;
            }
            const MAX_SUMMARY_LENGTH: usize = 4096;
            if content.len() > MAX_SUMMARY_LENGTH {
                let truncated = truncate_to_char_boundary(content, MAX_SUMMARY_LENGTH);
                return Some(format!("{truncated}..."));
            }
            Some(content.to_string())
        })
    }

    /// Update the coding agent turn summary with the final assistant message
    async fn update_executor_session_summary(&self, exec_id: &Uuid) -> Result<(), anyhow::Error> {
        // Check if there's a coding agent turn for this execution process
        let turn = CodingAgentTurn::find_by_execution_process_id(&self.db.pool, *exec_id).await?;

        if let Some(turn) = turn {
            // Only update if summary is not already set
            if turn.summary.is_none() {
                if let Some(summary) = self.extract_last_assistant_message(exec_id) {
                    CodingAgentTurn::update_summary(&self.db.pool, *exec_id, &summary).await?;
                } else {
                    tracing::debug!("No assistant message found for execution {}", exec_id);
                }
            }
        }

        Ok(())
    }

    /// Copy project files and workspace attachments to the workspace.
    /// Skips files that already exist (fast no-op if all exist).
    async fn copy_files_and_images(
        &self,
        workspace_dir: &Path,
        workspace: &Workspace,
    ) -> Result<(), ContainerError> {
        let repos = WorkspaceRepo::find_repos_with_copy_files(&self.db.pool, workspace.id).await?;

        for repo in &repos {
            if let Some(copy_files) = &repo.copy_files
                && !copy_files.trim().is_empty()
            {
                let worktree_path = workspace_dir.join(&repo.name);
                self.copy_project_files(&repo.path, &worktree_path, copy_files)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                            "Failed to copy project files for repo '{}': {}",
                            repo.name,
                            e
                        );
                    });
            }
        }

        let agent_working_dir = Session::find_latest_by_workspace_id(&self.db.pool, workspace.id)
            .await?
            .and_then(|session| session.agent_working_dir);

        if let Err(e) = self
            .file_service
            .copy_files_by_workspace_to_worktree(
                workspace_dir,
                workspace.id,
                agent_working_dir.as_deref(),
            )
            .await
        {
            tracing::warn!("Failed to copy workspace files to workspace: {}", e);
        }

        Ok(())
    }

    /// Create workspace-level CLAUDE.md and AGENTS.md files that import from each repo.
    /// Uses the @import syntax to reference each repo's config files.
    /// Skips creating files if they already exist or if no repos have the source file.
    async fn create_workspace_config_files(
        workspace_dir: &Path,
        repos: &[Repo],
    ) -> Result<(), ContainerError> {
        const CONFIG_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

        for config_file in CONFIG_FILES {
            let workspace_config_path = workspace_dir.join(config_file);

            if workspace_config_path.exists() {
                tracing::trace!(
                    "Workspace config file {} already exists, skipping",
                    config_file
                );
                continue;
            }

            let mut import_lines = Vec::new();
            for repo in repos {
                let repo_config_path = workspace_dir.join(&repo.name).join(config_file);
                if repo_config_path.exists() {
                    import_lines.push(format!("@{}/{}", repo.name, config_file));
                }
            }

            if import_lines.is_empty() {
                tracing::trace!(
                    "No repos have {}, skipping workspace config creation",
                    config_file
                );
                continue;
            }

            let content = import_lines.join("\n") + "\n";
            if let Err(e) = tokio::fs::write(&workspace_config_path, &content).await {
                tracing::warn!(
                    "Failed to create workspace config file {}: {}",
                    config_file,
                    e
                );
                continue;
            }

            tracing::info!(
                "Created workspace {} with {} import(s)",
                config_file,
                import_lines.len()
            );
        }

        Ok(())
    }

    /// Start a follow-up execution from a queued message
    async fn start_queued_follow_up(
        &self,
        ctx: &ExecutionContext,
        queued_data: &DraftFollowUpData,
    ) -> Result<ExecutionProcess, ContainerError> {
        let executor_profile_id = queued_data.executor_config.profile_id();

        // Validate executor matches session if session has prior executions
        let expected_executor: Option<String> =
            ExecutionProcess::latest_executor_profile_for_session(&self.db.pool, ctx.session.id)
                .await?
                .map(|profile| profile.executor.to_string())
                .or_else(|| ctx.session.executor.clone());

        if let Some(expected) = expected_executor {
            let actual = executor_profile_id.executor.to_string();
            if expected != actual {
                return Err(SessionError::ExecutorMismatch { expected, actual }.into());
            }
        }

        if ctx.session.executor.is_none() {
            Session::update_executor(
                &self.db.pool,
                ctx.session.id,
                &executor_profile_id.executor.to_string(),
            )
            .await?;
        }

        // Get latest agent turn for session continuity (from coding agent turns)
        let latest_session_info =
            CodingAgentTurn::find_latest_session_info(&self.db.pool, ctx.session.id).await?;

        let repos =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, ctx.workspace.id).await?;
        let cleanup_action = self.cleanup_actions_for_repos(&repos);

        let working_dir = ctx
            .session
            .agent_working_dir
            .as_ref()
            .filter(|dir| !dir.is_empty())
            .cloned();

        let action_type = if let Some(info) = latest_session_info {
            ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                prompt: queued_data.message.clone(),
                session_id: info.session_id,
                reset_to_message_id: None,
                executor_config: queued_data.executor_config.clone(),
                working_dir: working_dir.clone(),
            })
        } else {
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: queued_data.message.clone(),
                executor_config: queued_data.executor_config.clone(),
                working_dir,
            })
        };

        let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));

        self.start_execution(
            &ctx.workspace,
            &ctx.session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await
    }

    /// Try to promote the oldest queued execution to `running` and
    /// spawn it. Called after any process exits (freeing a slot) and
    /// after a queued process is cancelled. Loops until either the
    /// queue is drained, the concurrency limit is hit, or a start
    /// error occurs — each iteration owns exactly one slot.
    async fn drain_concurrency_queue(&self) {
        while let Some(next_id) = self.concurrency.try_dequeue().await {
            let ctx = match ExecutionProcess::load_context(&self.db.pool, next_id).await {
                Ok(ctx) => ctx,
                Err(e) => {
                    tracing::warn!(
                        execution_process_id = %next_id,
                        "Queued execution vanished before dequeue: {}",
                        e
                    );
                    // The row was deleted (or its parent workspace/session was)
                    // between enqueue and now. The slot we just reserved is
                    // ours — release it so the next iteration can try the
                    // following queued item on the freed slot.
                    self.concurrency.release(&next_id).await;
                    continue;
                }
            };

            // Skip queued rows that were soft-deleted between enqueue and
            // dequeue (e.g. by drop_at_and_after during history trim).
            if ctx.execution_process.dropped {
                tracing::info!(
                    execution_process_id = %next_id,
                    "Skipping dropped queued execution during drain"
                );
                self.concurrency.release(&next_id).await;
                continue;
            }

            let action = match ctx.execution_process.executor_action() {
                Ok(action) => action.clone(),
                Err(e) => {
                    tracing::error!(
                        execution_process_id = %next_id,
                        "Queued execution has invalid executor_action: {}",
                        e
                    );
                    self.concurrency.release(&next_id).await;
                    let _ = ExecutionProcess::update_completion(
                        &self.db.pool,
                        next_id,
                        ExecutionProcessStatus::Failed,
                        None,
                    )
                    .await;
                    continue;
                }
            };

            if let Err(e) = ExecutionProcess::mark_running(&self.db.pool, next_id).await {
                tracing::error!(
                    execution_process_id = %next_id,
                    "Failed to transition queued execution to running: {}",
                    e
                );
                self.concurrency.release(&next_id).await;
                continue;
            }

            // Reload the process so downstream sees status=running with
            // the refreshed started_at (mark_running updated both).
            let updated = match ExecutionProcess::find_by_id(&self.db.pool, next_id).await {
                Ok(Some(ep)) => ep,
                _ => {
                    self.concurrency.release(&next_id).await;
                    continue;
                }
            };

            // Ensure a MsgStore exists for the newly-running process —
            // start_execution_inner assumes one is in place (created by
            // start_execution during the original enqueue call, but if
            // we're recovering from a restart it may not be).
            {
                let mut stores = self.msg_stores.write().await;
                stores
                    .entry(next_id)
                    .or_insert_with(|| Arc::new(MsgStore::new()));
            }

            // Kick off the actual spawn in the background so a single
            // slow start does not block the drain loop from moving on
            // if the semaphore frees more slots concurrently.
            let container = self.clone();
            tokio::spawn(async move {
                if let Err(e) = container
                    .start_execution_inner(&ctx.workspace, &updated, &action)
                    .await
                {
                    tracing::error!(
                        execution_process_id = %next_id,
                        "Failed to start dequeued execution: {}",
                        e
                    );
                    let _ = ExecutionProcess::update_completion(
                        &container.db.pool,
                        next_id,
                        ExecutionProcessStatus::Failed,
                        None,
                    )
                    .await;
                    // A failed spawn releases the slot. We deliberately do
                    // NOT recurse into `drain_concurrency_queue` here — a
                    // recursive `async fn` inside `tokio::spawn` cannot be
                    // proved `Send` by the compiler. The next process exit
                    // (any other running executor finishing) will drain
                    // the queue via `spawn_exit_monitor`, so no queued
                    // task is lost — only mildly delayed on this rare
                    // error path.
                    container.concurrency.release(&next_id).await;
                }
            });
        }
    }

    /// Repopulate the in-memory queue from any `queued` rows left over
    /// in the database (e.g. after a server restart). Called once at
    /// startup so slots free up as running processes exit.
    async fn recover_concurrency_queue(&self) {
        match ExecutionProcess::find_queued(&self.db.pool).await {
            Ok(queued) => {
                let ids: Vec<Uuid> = queued.iter().map(|p| p.id).collect();
                if !ids.is_empty() {
                    tracing::info!(
                        "Recovering {} queued execution process(es) after startup",
                        ids.len()
                    );
                    self.concurrency.recover_queue(ids).await;
                    self.drain_concurrency_queue().await;
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to load queued execution processes at startup: {}",
                    e
                );
            }
        }
    }
}

fn failure_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(256) // Exit code 1 (shifted by 8 bits)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(1)
    }
}

/// After a process exits, scan its msg_store history newest-first for the
/// last emitted `TokenUsageInfo`, use the executor's own USD figure when
/// present (Claude Code), otherwise estimate it from the token counts +
/// the model's entry in the Rust-side pricing table. Persist the result
/// on the `execution_processes` row and add the delta to the owning task.
/// Best-effort: any failure is logged and swallowed so a broken run still
/// finalizes cleanly.
async fn persist_execution_process_usage(
    db: &DBService,
    msg_stores: &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    exec_id: Uuid,
) {
    let Some(msg_store) = msg_stores.read().await.get(&exec_id).cloned() else {
        return;
    };

    // Newest first — the last emitted TokenUsageInfo carries the cumulative
    // breakdown (for Claude also the vendor-reported USD).
    let Some(usage_info) = msg_store.find_map_history_rev(|msg| {
        let LogMsg::JsonPatch(patch) = msg else {
            return None;
        };
        let (_, entry) = extract_normalized_entry_from_patch(patch)?;
        match entry.entry_type {
            NormalizedEntryType::TokenUsageInfo(info) => Some(info),
            _ => None,
        }
    }) else {
        return;
    };

    // Fall back to reading the executor's model from the persisted
    // executor_action when the executor did not put it on the usage entry.
    let model_from_action = ExecutionProcess::find_by_id(&db.pool, exec_id)
        .await
        .ok()
        .flatten()
        .and_then(|ep| model_from_executor_action(&ep));
    let model = usage_info.model.clone().or(model_from_action);

    let tokens = executors::pricing::UsageTokens {
        input_tokens: usage_info.input_tokens.unwrap_or(0),
        output_tokens: usage_info.output_tokens.unwrap_or(0),
        cache_creation_tokens: usage_info.cache_creation_input_tokens.unwrap_or(0),
        cache_read_tokens: usage_info.cache_read_input_tokens.unwrap_or(0),
    };

    // Prefer the executor's own USD figure (Claude); otherwise estimate.
    let cost_usd = usage_info.total_cost_usd.or_else(|| {
        model
            .as_deref()
            .and_then(|m| executors::pricing::estimate_cost_usd(m, &tokens))
    });

    let usage = db::models::execution_process::ExecutionProcessUsage {
        input_tokens: usage_info.input_tokens.map(|n| n as i64),
        output_tokens: usage_info.output_tokens.map(|n| n as i64),
        cache_creation_tokens: usage_info.cache_creation_input_tokens.map(|n| n as i64),
        cache_read_tokens: usage_info.cache_read_input_tokens.map(|n| n as i64),
        cost_usd,
        model,
    };

    if usage.is_empty() {
        return;
    }

    if let Err(e) = ExecutionProcess::set_usage(&db.pool, exec_id, &usage).await {
        tracing::warn!(
            "Failed to persist LLM usage for execution process {}: {}",
            exec_id,
            e
        );
        return;
    }

    // Roll the just-persisted delta up to the owning task, if any.
    let session_id = match ExecutionProcess::find_by_id(&db.pool, exec_id).await {
        Ok(Some(ep)) => ep.session_id,
        _ => return,
    };

    if let Err(e) = db::models::worker_task::WorkerTask::add_usage_delta_by_session(
        &db.pool,
        session_id,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_tokens,
        usage.cache_read_tokens,
        usage.cost_usd,
    )
    .await
    {
        tracing::warn!(
            "Failed to roll up LLM usage to worker_tasks for session {}: {}",
            session_id,
            e
        );
    }
}

/// Best-effort model extraction from the persisted `executor_action` blob,
/// used as a fallback when the executor did not stamp the model on its
/// `TokenUsageInfo` (e.g. Codex, which only surfaces token counts).
fn model_from_executor_action(ep: &ExecutionProcess) -> Option<String> {
    let action = ep.executor_action().ok()?;
    match &action.typ {
        executors::actions::ExecutorActionType::CodingAgentInitialRequest(req) => {
            req.executor_config.model_id.clone()
        }
        executors::actions::ExecutorActionType::CodingAgentFollowUpRequest(req) => {
            req.executor_config.model_id.clone()
        }
        executors::actions::ExecutorActionType::ReviewRequest(req) => {
            req.executor_config.model_id.clone()
        }
        executors::actions::ExecutorActionType::ScriptRequest(_) => None,
    }
}

#[async_trait]
impl ContainerService for LocalContainerService {
    fn msg_stores(&self) -> &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>> {
        &self.msg_stores
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn notification_service(&self) -> &NotificationService {
        &self.notification_service
    }

    fn web_push(&self) -> Option<&WebPushService> {
        self.web_push.as_ref()
    }

    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    fn concurrency(&self) -> Option<&ConcurrencySemaphore> {
        Some(&self.concurrency)
    }

    async fn drain_queue(&self) {
        self.drain_concurrency_queue().await;
    }

    async fn touch(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        let now = Instant::now();

        // We debounce touches to avoid excessive database writes, which in SQLites causes DB locks
        let should_debounce = |last_touch: &Instant| -> bool {
            now.duration_since(*last_touch) < WORKSPACE_TOUCH_DEBOUNCE
        };

        // Quick check with read lock
        if self
            .workspace_touch_times
            .read()
            .await
            .get(&workspace.id)
            .is_some_and(should_debounce)
        {
            return Ok(());
        }

        let mut map = self.workspace_touch_times.write().await;
        // Clean up stale entries older than the debounce window, reduce memory usage over time
        map.retain(|_, time| should_debounce(time));
        // check in case another thread has touched already
        if map.get(&workspace.id).is_some_and(should_debounce) {
            return Ok(());
        }
        map.insert(workspace.id, now);
        drop(map);

        Workspace::touch(&self.db.pool, workspace.id).await?;
        Ok(())
    }

    async fn store_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        self.add_db_stream_handle(id, handle).await;
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        LocalContainerService::take_db_stream_handle(self, id).await
    }

    async fn git_branch_prefix(&self) -> String {
        self.config.read().await.git_branch_prefix.clone()
    }

    fn workspace_to_current_dir(&self, workspace: &Workspace) -> PathBuf {
        PathBuf::from(workspace.container_ref.clone().unwrap_or_default())
    }

    async fn create(&self, workspace: &Workspace) -> Result<ContainerRef, ContainerError> {
        let label = workspace.name.as_deref().unwrap_or("workspace");
        let workspace_dir_name =
            LocalContainerService::dir_name_from_workspace(&workspace.id, label);
        let workspace_dir = WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name);

        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        // For workspaces bound to an existing PR (fix-tasks and reviewer
        // tasks), materialize the worktree directly on the PR head instead of
        // on the target branch. Failure here propagates and the caller
        // (`worker_orchestrator::try_take_next`) rolls back the workspace and
        // releases the task claim — no half-materialized state left behind.
        let workspace_inputs = self
            .with_pr_head_starting_points(workspace.id, workspace_inputs)
            .await?;

        let created_workspace = WorkspaceManager::create_workspace(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        // Copy project files and images to workspace
        self.copy_files_and_images(&created_workspace.workspace_dir, workspace)
            .await?;

        Self::create_workspace_config_files(&created_workspace.workspace_dir, &repositories)
            .await?;

        Workspace::update_container_ref(
            &self.db.pool,
            workspace.id,
            &created_workspace.workspace_dir.to_string_lossy(),
        )
        .await?;

        Ok(created_workspace
            .workspace_dir
            .to_string_lossy()
            .to_string())
    }

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        self.try_stop(workspace, true).await;
        self.cleanup_workspace(workspace).await;
        Ok(())
    }

    async fn ensure_container_exists(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError> {
        self.touch(workspace).await?;
        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        let workspace_dir = if let Some(container_ref) = &workspace.container_ref {
            PathBuf::from(container_ref)
        } else {
            let label = workspace.name.as_deref().unwrap_or("workspace");
            let workspace_dir_name =
                LocalContainerService::dir_name_from_workspace(&workspace.id, label);
            WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name)
        };

        WorkspaceManager::ensure_workspace_exists(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        if workspace.container_ref.is_none() {
            Workspace::update_container_ref(
                &self.db.pool,
                workspace.id,
                &workspace_dir.to_string_lossy(),
            )
            .await?;
        }

        if workspace.worktree_deleted {
            Workspace::clear_worktree_deleted(&self.db.pool, workspace.id).await?;
        }

        // Copy project files and images (fast no-op if already exist)
        self.copy_files_and_images(&workspace_dir, workspace)
            .await?;

        Self::create_workspace_config_files(&workspace_dir, &repositories).await?;

        Ok(workspace_dir.to_string_lossy().to_string())
    }

    async fn is_container_clean(&self, workspace: &Workspace) -> Result<bool, ContainerError> {
        let Some(container_ref) = &workspace.container_ref else {
            return Ok(true);
        };

        let workspace_dir = PathBuf::from(container_ref);
        if !workspace_dir.exists() {
            return Ok(true);
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        for repo in &repositories {
            let worktree_path = workspace_dir.join(&repo.name);
            if worktree_path.exists() {
                let (uncommitted, untracked) =
                    self.git().get_worktree_change_counts(&worktree_path)?;
                if uncommitted > 0 || untracked > 0 {
                    return Ok(false);
                }
            }
        }

        Ok(true)
    }

    async fn start_execution_inner(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        // Gate coding-agent spawns behind the concurrency semaphore.
        // Other run reasons (setup / cleanup / archive scripts, dev
        // servers) always spawn immediately — the limit is about how
        // many *agents* run in parallel, not how many child processes
        // in total the box is running. Fluke (a mission session) is not
        // one of those agents: its reply never waits behind the workers.
        let is_director = db::models::mission::Mission::find_by_session_id(
            &self.db.pool,
            execution_process.session_id,
        )
        .await?
        .is_some();
        if matches!(
            execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent
        ) && !is_director
            && !self.concurrency.try_acquire(execution_process.id).await
        {
            if let Err(e) = ExecutionProcess::mark_queued(&self.db.pool, execution_process.id).await
            {
                tracing::error!(
                    "Failed to mark execution process {} as queued: {}",
                    execution_process.id,
                    e
                );
                return Err(e.into());
            }
            self.concurrency.enqueue(execution_process.id).await;
            tracing::info!(
                execution_process_id = %execution_process.id,
                workspace_id = %workspace.id,
                "Concurrency limit reached; execution queued"
            );
            return Ok(());
        }

        // Get the worktree path
        let container_ref = workspace
            .container_ref
            .as_ref()
            .ok_or(ContainerError::Other(anyhow!(
                "Container ref not found for workspace"
            )))?;
        let current_dir = PathBuf::from(container_ref);

        let approvals_service: Arc<dyn ExecutorApprovalService> =
            match executor_action.base_executor() {
                Some(
                    BaseCodingAgent::Codex
                    | BaseCodingAgent::ClaudeCode
                    | BaseCodingAgent::Gemini
                    | BaseCodingAgent::QwenCode
                    | BaseCodingAgent::Opencode,
                ) => ExecutorApprovalBridge::new(
                    self.approvals.clone(),
                    self.db.clone(),
                    self.notification_service.clone(),
                    execution_process.id,
                ),
                _ => Arc::new(NoopExecutorApprovalService {}),
            };

        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let repo_names: Vec<String> = repos.iter().map(|r| r.name.clone()).collect();
        let repo_context = RepoContext::new(current_dir.clone(), repo_names);

        let mut env = ExecutionEnv::new(repo_context);

        // Always inject workspace/session context
        env.insert("VK_WORKSPACE_ID", workspace.id.to_string());
        env.insert("VK_WORKSPACE_BRANCH", &workspace.branch);

        // Claude only. A mission session gets the Director's MCP and system
        // prompt instead of the plan MCP; every other agent gets the plan
        // MCP: it declares and walks its plan against this server, which
        // renders it as a live graph.
        if matches!(
            executor_action.base_executor(),
            Some(BaseCodingAgent::ClaudeCode)
        ) {
            let session_id = execution_process.session_id;
            if let Some(mission) =
                db::models::mission::Mission::find_by_session_id(&self.db.pool, session_id).await?
            {
                if let Some(url) =
                    utils::plan_mcp::director_url_for_session(&session_id.to_string())
                {
                    env.insert(utils::plan_mcp::DIRECTOR_MCP_URL_ENV, url);
                    env.insert(
                        utils::plan_mcp::DIRECTOR_PROMPT_ENV,
                        services::services::director::system_prompt(&self.db.pool, &mission)
                            .await?,
                    );
                    env.insert(
                        utils::plan_mcp::DIRECTOR_CONTEXT_ENV,
                        services::services::director::turn_context(&self.db.pool, &mission)
                            .await?,
                    );
                }
            } else if let Some(url) = utils::plan_mcp::url_for_workspace(&workspace.id.to_string())
            {
                env.insert(utils::plan_mcp::PLAN_MCP_URL_ENV, url);
            }
        }

        // Deliberately do NOT inject the worker's PAT as GH_TOKEN/GITHUB_TOKEN
        // into the agent process env. Since agent-actions F1+F2+F3, every
        // GitHub write is drained server-side by `agent_actions_drain` using
        // the worker's PAT — the agent produces content; the system produces
        // effects. Handing the token to the agent process only reopens the
        // old prompt-driven `gh pr create`/`gh issue comment` path we just
        // purged. Inherited GH_TOKEN/GITHUB_TOKEN from the server env is
        // scrubbed centrally in `ExecutionEnv::apply_to_command` so no
        // executor spawn can leak it back in either. Git operations
        // (developer push, reviewer `git fetch pull/N/head`) fall back to the
        // machine's `gh auth setup-git` credentials — the same fallback that
        // already covered reviewers.

        // Create the child and stream, add to execution tracker with timeout
        let mut spawned = tokio::time::timeout(
            Duration::from_secs(30),
            executor_action.spawn(&current_dir, approvals_service, &env),
        )
        .await
        .map_err(|_| {
            ContainerError::Other(anyhow!(
                "Timeout: process took more than 30 seconds to start"
            ))
        })??;

        if let Err(e) = self
            .track_child_msgs_in_store(execution_process.id, &mut spawned.child)
            .await
        {
            let _ = command::kill_process_group(&mut spawned.child).await;
            return Err(e);
        }

        self.add_child_to_store(execution_process.id, spawned.child)
            .await;

        // Store cancellation token for graceful shutdown
        if let Some(cancel) = spawned.cancel {
            self.add_cancellation_token(execution_process.id, cancel)
                .await;
        }

        // Spawn unified exit monitor: watches OS exit and optional executor signal
        let hn = self.spawn_exit_monitor(&execution_process.id, spawned.exit_signal);
        self.add_exit_monitor_handle(execution_process.id, hn).await;

        Ok(())
    }

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError> {
        // A queued process has no child process yet: just drop it from the
        // wait queue and record the terminal status. Without this branch we
        // would fail with "Child process not found" and leave the row stuck
        // in `queued` forever.
        if execution_process.status == ExecutionProcessStatus::Queued {
            let exit_code = if status == ExecutionProcessStatus::Completed {
                Some(0)
            } else {
                None
            };
            ExecutionProcess::update_completion(
                &self.db.pool,
                execution_process.id,
                status,
                exit_code,
            )
            .await?;
            self.concurrency.release(&execution_process.id).await;
            // Wake up the next queued execution if the cancelled slot
            // opened a spot (release also removes from the FIFO).
            self.drain_concurrency_queue().await;
            if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
                msg.push_finished();
            }
            return Ok(());
        }

        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };

        // Missing child = row is a zombie: the OS process is gone (or was
        // never here — e.g. after a partial spawn or restart) but nobody
        // ever finalised the DB row. Historically we errored out here and
        // every caller swallowed the error, leaving the row stuck as
        // `running` forever. Instead, close it out idempotently: update the
        // DB, release the semaphore slot, drain the queue, and finalise the
        // MsgStore so any subscriber sees the terminal signal.
        let Some(child) = self.get_child_from_store(&execution_process.id).await else {
            tracing::warn!(
                "stop_execution: child for {} not in store; finalising zombie row as {:?}",
                execution_process.id,
                status
            );
            ExecutionProcess::update_completion(
                &self.db.pool,
                execution_process.id,
                status,
                exit_code,
            )
            .await?;
            self.concurrency.release(&execution_process.id).await;
            self.drain_concurrency_queue().await;
            // Drop any lingering in-memory handles: cancellation token,
            // exit monitor, db stream. They should already be gone if the
            // child exited normally, but during a partial spawn or after a
            // sweep detects a stale row they may still be around.
            let _ = self.take_cancellation_token(&execution_process.id).await;
            let _ = self.take_exit_monitor_handle(&execution_process.id).await;
            let db_stream_handle = self.take_db_stream_handle(&execution_process.id).await;
            if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
                msg.push_finished();
            }
            if let Some(handle) = db_stream_handle {
                let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
            }
            return Ok(());
        };

        ExecutionProcess::update_completion(&self.db.pool, execution_process.id, status, exit_code)
            .await?;

        // Try graceful cancellation first, then force kill
        if let Some(cancel) = self.take_cancellation_token(&execution_process.id).await {
            cancel.cancel();

            // Wait for exit monitor to finish gracefully
            if let Some(monitor_handle) = self.take_exit_monitor_handle(&execution_process.id).await
            {
                match tokio::time::timeout(Duration::from_secs(5), monitor_handle).await {
                    Ok(_) => {
                        tracing::debug!("Process {} exited gracefully", execution_process.id);
                    }
                    Err(_) => {
                        tracing::debug!(
                            "Graceful shutdown timed out for process {}, force killing",
                            execution_process.id
                        );
                    }
                }
            }
        }

        {
            let mut child_guard = child.write().await;
            if let Err(e) = command::kill_process_group(&mut child_guard).await {
                tracing::error!(
                    "Failed to stop execution process {}: {}",
                    execution_process.id,
                    e
                );
                return Err(e);
            }
        }
        self.remove_child_from_store(&execution_process.id).await;

        // Mark the process finished in the MsgStore and wait for DB persistence
        let db_stream_handle = self.take_db_stream_handle(&execution_process.id).await;
        if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
            msg.push_finished();
        }
        if let Some(handle) = db_stream_handle {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }

        tracing::debug!(
            "Execution process {} stopped successfully",
            execution_process.id
        );

        // Record after-head commit OID (best-effort)
        self.update_after_head_commits(execution_process.id).await;

        Ok(())
    }

    async fn stream_diff(
        &self,
        workspace: &Workspace,
        stats_only: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, ContainerError>
    {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        let mut streams = Vec::new();

        let container_ref = self.ensure_container_exists(workspace).await?;
        let workspace_root = PathBuf::from(container_ref);

        for repo in repositories {
            let worktree_path = workspace_root.join(&repo.name);
            let branch = &workspace.branch;

            let Some(target_branch) = target_branches.get(&repo.id) else {
                tracing::warn!(
                    "Skipping diff stream for repo {}: no target branch configured",
                    repo.name
                );
                continue;
            };

            let base_commit = match self
                .git()
                .get_base_commit(&repo.path, branch, target_branch)
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "Skipping diff stream for repo {}: failed to get base commit: {}",
                        repo.name,
                        e
                    );
                    continue;
                }
            };

            let stream = self
                .create_live_diff_stream(diff_stream::DiffStreamArgs {
                    git_service: self.git().clone(),
                    db: self.db().clone(),
                    workspace_id: workspace.id,
                    repo_id: repo.id,
                    repo_path: repo.path.clone(),
                    worktree_path: worktree_path.clone(),
                    branch: branch.to_string(),
                    target_branch: target_branch.clone(),
                    base_commit: base_commit.clone(),
                    stats_only,
                    path_prefix: Some(repo.name.clone()),
                })
                .await?;

            streams.push(Box::pin(stream));
        }

        if streams.is_empty() {
            return Ok(Box::pin(futures::stream::empty()));
        }

        // Merge all streams into one
        Ok(Box::pin(futures::stream::select_all(streams)))
    }

    async fn try_commit_changes(&self, ctx: &ExecutionContext) -> Result<bool, ContainerError> {
        if !matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent | ExecutionProcessRunReason::CleanupScript,
        ) {
            return Ok(false);
        }

        let message = self.get_commit_message(ctx).await;

        let container_ref = ctx
            .workspace
            .container_ref
            .as_ref()
            .ok_or_else(|| ContainerError::Other(anyhow!("Container reference not found")))?;
        let workspace_root = PathBuf::from(container_ref);

        let repos_with_changes = self.check_repos_for_changes(&workspace_root, &ctx.repos)?;
        if repos_with_changes.is_empty() {
            tracing::debug!("No changes to commit in any repository");
            return Ok(false);
        }

        Ok(self.commit_repos(repos_with_changes, &message))
    }

    /// Copy files from the original project directory to the worktree.
    /// Skips files that already exist at target with same size.
    async fn copy_project_files(
        &self,
        source_dir: &Path,
        target_dir: &Path,
        copy_files: &str,
    ) -> Result<(), ContainerError> {
        let source_dir = source_dir.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        let copy_files = copy_files.to_string();

        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                copy::copy_project_files_impl(&source_dir, &target_dir, &copy_files)
            }),
        )
        .await
        .map_err(|_| ContainerError::Other(anyhow!("Copy project files timed out after 30s")))?
        .map_err(|e| ContainerError::Other(anyhow!("Copy files task failed: {e}")))?
    }

    async fn kill_all_running_processes(&self) -> Result<(), ContainerError> {
        tracing::info!("Killing all running processes");
        let running_processes = ExecutionProcess::find_running(&self.db.pool).await?;

        tracing::info!(
            "Found {} running processes to kill",
            running_processes.len()
        );

        for process in running_processes {
            tracing::info!(
                "Killing process: id={}, run_reason={:?}",
                process.id,
                process.run_reason
            );
            if let Err(error) = self
                .stop_execution(&process, ExecutionProcessStatus::Killed)
                .await
            {
                tracing::error!(
                    "Failed to cleanly kill running execution process {:?}: {:?}",
                    process,
                    error
                );
            } else {
                tracing::info!("Successfully killed process: id={}", process.id);
            }
        }

        Ok(())
    }
}
fn success_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
}
