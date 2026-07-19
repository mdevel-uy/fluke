use std::{sync::Arc, time::Duration};

use api_types::{PullRequestStatus, UpdatePullRequestApiRequest, UpsertPullRequestRequest};
use chrono::Utc;
use db::{
    DBService,
    models::{
        merge::MergeStatus,
        pull_request::PullRequest,
        repo::Repo,
        workspace::{Workspace, WorkspaceError},
        worker_task::WorkerTask,
        workspace_repo::WorkspaceRepo,
    },
};
use git_host::{GitHostError, GitHostProvider, GitHostService};
use serde_json::json;
use sqlx::error::Error as SqlxError;
use thiserror::Error;
use tokio::{
    sync::{Notify, RwLock},
    time::interval,
};
use tracing::{debug, error, info, warn};

use crate::services::{
    analytics::AnalyticsContext,
    config::Config,
    container::ContainerService,
    remote_client::{RemoteClient, RemoteClientError},
    remote_sync, worker_orchestrator,
};

#[derive(Debug, Error)]
enum PrMonitorError {
    #[error(transparent)]
    GitHostError(#[from] GitHostError),
    #[error(transparent)]
    WorkspaceError(#[from] WorkspaceError),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
}

impl PrMonitorError {
    fn is_environmental(&self) -> bool {
        matches!(
            self,
            PrMonitorError::GitHostError(
                GitHostError::CliNotInstalled { .. } | GitHostError::NotAGitRepository(_)
            )
        )
    }
}

/// Service to monitor PRs and update task status when they are merged
pub struct PrMonitorService<C: ContainerService> {
    db: DBService,
    poll_interval: Duration,
    analytics: Option<AnalyticsContext>,
    container: C,
    remote_client: Option<RemoteClient>,
    sync_notify: Arc<Notify>,
    config: Arc<RwLock<Config>>,
}

impl<C: ContainerService + Send + Sync + 'static> PrMonitorService<C> {
    pub async fn spawn(
        db: DBService,
        analytics: Option<AnalyticsContext>,
        container: C,
        remote_client: Option<RemoteClient>,
        sync_notify: Arc<Notify>,
        config: Arc<RwLock<Config>>,
    ) -> tokio::task::JoinHandle<()> {
        let service = Self {
            db,
            poll_interval: Duration::from_secs(60),
            analytics,
            container,
            remote_client,
            sync_notify,
            config,
        };
        tokio::spawn(async move {
            service.start().await;
        })
    }

    async fn start(&self) {
        info!(
            "Starting PR monitoring service with interval {:?}",
            self.poll_interval
        );

        let mut interval = interval(self.poll_interval);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Err(e) = self.check_all_open_prs().await {
                        error!("Error checking open PRs: {}", e);
                    }
                    self.check_in_progress_workspaces_for_prs().await;
                }
                _ = self.sync_notify.notified() => {
                    debug!("PR sync triggered externally");
                }
            }
            self.sync_pending_to_remote().await;
        }
    }

    /// Sweep all in-progress worker-task workspaces and adopt any GitHub PR
    /// that was created outside the app (e.g. by the agent via `gh pr create`).
    /// Errors for individual workspaces are logged and skipped; the sweep never
    /// aborts mid-run.
    async fn check_in_progress_workspaces_for_prs(&self) {
        let tasks =
            match WorkerTask::find_all_in_progress_with_workspace(&self.db.pool).await {
                Ok(t) => t,
                Err(e) => {
                    error!("Failed to query in-progress tasks for PR adoption sweep: {}", e);
                    return;
                }
            };

        if tasks.is_empty() {
            return;
        }

        debug!(
            "Checking {} in-progress workspace(s) for unregistered PRs",
            tasks.len()
        );

        for task in &tasks {
            if let Some(workspace_id) = task.workspace_id {
                self.try_adopt_pr_for_workspace(workspace_id).await;
            }
        }
    }

    /// For a single workspace that has an in-progress worker task, look up
    /// GitHub for any PR on the workspace's branch and adopt it if not yet
    /// registered.  All failures are logged and the method always returns
    /// cleanly so the sweep can continue.
    async fn try_adopt_pr_for_workspace(&self, workspace_id: uuid::Uuid) {
        // Skip if the workspace already has at least one PR recorded.
        match PullRequest::find_by_workspace_id(&self.db.pool, workspace_id).await {
            Ok(prs) if !prs.is_empty() => return,
            Err(e) => {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to query existing PRs for workspace during adoption sweep: {}",
                    e
                );
                return;
            }
            Ok(_) => {}
        }

        let workspace = match Workspace::find_by_id(&self.db.pool, workspace_id).await {
            Ok(Some(ws)) => ws,
            Ok(None) => return,
            Err(e) => {
                warn!(workspace_id = %workspace_id, "Failed to load workspace during adoption sweep: {}", e);
                return;
            }
        };

        let workspace_repos =
            match WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await {
                Ok(repos) => repos,
                Err(e) => {
                    warn!(
                        workspace_id = %workspace_id,
                        "Failed to load workspace repos during adoption sweep: {}",
                        e
                    );
                    return;
                }
            };

        for workspace_repo in &workspace_repos {
            let repo =
                match Repo::find_by_id(&self.db.pool, workspace_repo.repo_id).await {
                    Ok(Some(r)) => r,
                    _ => continue,
                };

            let git = self.container.git();
            let remote =
                match git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch) {
                    Ok(r) => r,
                    Err(e) => {
                        debug!(
                            workspace_id = %workspace_id,
                            "Could not resolve remote for adoption sweep: {}",
                            e
                        );
                        continue;
                    }
                };

            let git_host = match GitHostService::from_url(&remote.url) {
                Ok(host) => host,
                Err(_) => continue,
            };

            let prs = match git_host
                .list_prs_for_branch(&repo.path, &remote.url, &workspace.branch)
                .await
            {
                Ok(prs) => prs,
                Err(
                    GitHostError::CliNotInstalled { .. }
                    | GitHostError::NotAGitRepository(_),
                ) => {
                    debug!(
                        workspace_id = %workspace_id,
                        "Skipping adoption sweep for workspace due to environmental issue"
                    );
                    return;
                }
                Err(e) => {
                    warn!(
                        workspace_id = %workspace_id,
                        branch = %workspace.branch,
                        "Failed to list PRs during adoption sweep: {}",
                        e
                    );
                    continue;
                }
            };

            let pr_info = match prs.into_iter().next() {
                Some(pr) => pr,
                None => continue,
            };

            info!(
                workspace_id = %workspace_id,
                branch = %workspace.branch,
                pr_number = pr_info.number,
                pr_status = ?pr_info.status,
                "Auto-adopting PR for in-progress workspace"
            );

            // Record the PR locally.
            if let Err(e) = PullRequest::create_for_workspace(
                &self.db.pool,
                workspace_id,
                workspace_repo.repo_id,
                &workspace_repo.target_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            {
                error!(
                    workspace_id = %workspace_id,
                    "Failed to save adopted PR record: {}",
                    e
                );
                continue;
            }

            // Update status in DB if the PR is already closed/merged.
            if !matches!(pr_info.status, MergeStatus::Open) {
                let merged_at = if matches!(&pr_info.status, MergeStatus::Merged) {
                    pr_info.merged_at
                } else {
                    None
                };
                if let Err(e) = PullRequest::update_status(
                    &self.db.pool,
                    &pr_info.url,
                    &pr_info.status,
                    merged_at,
                    pr_info.merge_commit_sha.clone(),
                )
                .await
                {
                    error!(
                        workspace_id = %workspace_id,
                        "Failed to update adopted PR status: {}",
                        e
                    );
                }
            }

            // Sync to remote server.
            if let Some(client) = &self.remote_client {
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
                    target_branch_name: workspace_repo.target_branch.clone(),
                    local_workspace_id: workspace_id,
                };
                remote_sync::sync_pr_to_remote(client, upsert_req).await;
            }

            // Advance the worker-task state machine.
            match &pr_info.status {
                MergeStatus::Open => {
                    if let Err(e) =
                        worker_orchestrator::on_pr_open(&self.db, workspace_id).await
                    {
                        warn!(
                            workspace_id = %workspace_id,
                            "Failed to move task to in_review after PR adoption: {}",
                            e
                        );
                    }
                }
                MergeStatus::Merged => {
                    if let Err(e) =
                        self.try_archive_workspace(workspace_id, pr_info.number).await
                    {
                        error!(
                            workspace_id = %workspace_id,
                            "Failed to archive workspace after merged-PR adoption: {}",
                            e
                        );
                    }
                    match worker_orchestrator::on_pr_merged(
                        &self.config,
                        &self.db,
                        &self.container,
                        workspace_id,
                    )
                    .await
                    {
                        Ok(true) => info!(
                            workspace_id = %workspace_id,
                            "Worker took next task after adopted PR merge"
                        ),
                        Ok(false) => {}
                        Err(e) => warn!(
                            workspace_id = %workspace_id,
                            "Failed to reconcile worker task after adopted PR merge: {}",
                            e
                        ),
                    }
                }
                _ => {}
            }
        }
    }

    /// Check all open PRs for updates
    async fn check_all_open_prs(&self) -> Result<(), PrMonitorError> {
        let open_prs = PullRequest::get_open(&self.db.pool).await?;

        if open_prs.is_empty() {
            debug!("No open PRs to check");
            return Ok(());
        }

        info!("Checking {} open PRs", open_prs.len());
        for pr in &open_prs {
            if let Err(e) = self.check_open_pr(pr).await {
                if e.is_environmental() {
                    warn!(
                        "Skipping PR #{} due to environmental error: {}",
                        pr.pr_number, e
                    );
                } else {
                    error!("Error checking PR #{}: {}", pr.pr_number, e);
                }
            }
        }

        Ok(())
    }

    /// Check the status of a single open PR and handle state changes.
    async fn check_open_pr(&self, pr: &PullRequest) -> Result<(), PrMonitorError> {
        let git_host = GitHostService::from_url(&pr.pr_url)?;
        let status = git_host.get_pr_status(&pr.pr_url).await?;

        debug!(
            "PR #{} status: {:?} (was open)",
            pr.pr_number, status.status
        );

        if matches!(&status.status, MergeStatus::Open) {
            // PR is still open — reconcile the worker-task state machine.
            // This is idempotent: it only transitions in_progress → in_review
            // for a worker-owned workspace, and no-ops otherwise.
            if let Some(workspace_id) = pr.workspace_id
                && let Err(e) = worker_orchestrator::on_pr_open(&self.db, workspace_id).await
            {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to reconcile worker task on PR open: {}",
                    e
                );
            }
            return Ok(());
        }

        let merged_at = if matches!(&status.status, MergeStatus::Merged) {
            Some(status.merged_at.unwrap_or_else(Utc::now))
        } else {
            None
        };

        PullRequest::update_status(
            &self.db.pool,
            &pr.pr_url,
            &status.status,
            merged_at,
            status.merge_commit_sha.clone(),
        )
        .await?;

        // If this is a workspace PR and it was merged, try to archive
        if matches!(&status.status, MergeStatus::Merged)
            && let Some(workspace_id) = pr.workspace_id
        {
            self.try_archive_workspace(workspace_id, pr.pr_number)
                .await?;

            // Reconcile worker orchestration: task → done, then try to take
            // the next queued task for the worker. Errors here are logged
            // but never bubbled up: PR bookkeeping already succeeded.
            match worker_orchestrator::on_pr_merged(
                &self.config,
                &self.db,
                &self.container,
                workspace_id,
            )
            .await
            {
                Ok(true) => info!(
                    workspace_id = %workspace_id,
                    "Worker took next task after PR merge",
                ),
                Ok(false) => {}
                Err(e) => warn!(
                    workspace_id = %workspace_id,
                    "Failed to reconcile worker task on PR merge: {}",
                    e
                ),
            }
        }

        info!("PR #{} status changed to {:?}", pr.pr_number, status.status);

        Ok(())
    }

    /// Archive workspace if all its PRs are merged/closed
    async fn try_archive_workspace(
        &self,
        workspace_id: uuid::Uuid,
        pr_number: i64,
    ) -> Result<(), PrMonitorError> {
        let Some(workspace) = Workspace::find_by_id(&self.db.pool, workspace_id).await? else {
            return Ok(());
        };

        let open_pr_count =
            PullRequest::count_open_for_workspace(&self.db.pool, workspace_id).await?;

        if open_pr_count == 0 {
            info!(
                "PR #{} was merged, archiving workspace {}",
                pr_number, workspace.id
            );
            if !workspace.pinned
                && let Err(e) = self.container.archive_workspace(workspace.id).await
            {
                error!("Failed to archive workspace {}: {}", workspace.id, e);
            }

            if let Some(analytics) = &self.analytics {
                analytics.analytics_service.track_event(
                    &analytics.user_id,
                    "pr_merged",
                    Some(json!({
                        "workspace_id": workspace.id.to_string(),
                    })),
                );
            }
        } else {
            info!(
                "PR #{} was merged, leaving workspace {} active with {} open PR(s)",
                pr_number, workspace.id, open_pr_count
            );
        }

        Ok(())
    }

    /// Sync pending PR status changes to remote server.
    async fn sync_pending_to_remote(&self) {
        let Some(client) = &self.remote_client else {
            return;
        };

        let pending = match PullRequest::get_pending_sync(&self.db.pool).await {
            Ok(prs) => prs,
            Err(e) => {
                error!("Failed to query pending sync PRs: {}", e);
                return;
            }
        };

        if pending.is_empty() {
            return;
        }

        debug!("Syncing {} pending PRs to remote", pending.len());

        for pr in &pending {
            let pr_api_status = match &pr.pr_status {
                MergeStatus::Open => PullRequestStatus::Open,
                MergeStatus::Merged => PullRequestStatus::Merged,
                MergeStatus::Closed => PullRequestStatus::Closed,
                MergeStatus::Unknown => continue,
            };

            let request = UpdatePullRequestApiRequest {
                url: pr.pr_url.clone(),
                status: Some(pr_api_status),
                merged_at: pr.merged_at.map(Some),
                merge_commit_sha: pr.merge_commit_sha.clone().map(Some),
            };

            match client.update_pull_request(request).await {
                Ok(_) => {
                    if let Err(e) = PullRequest::mark_synced(&self.db.pool, &pr.id).await {
                        error!("Failed to mark PR #{} as synced: {}", pr.pr_number, e);
                    }
                }
                Err(RemoteClientError::Http { status: 404, .. }) => {
                    if let Some(workspace_id) = pr.workspace_id {
                        let request = UpsertPullRequestRequest {
                            url: pr.pr_url.clone(),
                            number: pr.pr_number as i32,
                            status: pr_api_status,
                            merged_at: pr.merged_at,
                            merge_commit_sha: pr.merge_commit_sha.clone(),
                            target_branch_name: pr.target_branch_name.clone(),
                            local_workspace_id: workspace_id,
                        };
                        remote_sync::sync_pr_to_remote(client, request).await;
                        if let Err(e) = PullRequest::mark_synced(&self.db.pool, &pr.id).await {
                            error!("Failed to mark PR #{} as synced: {}", pr.pr_number, e);
                        }
                    } else {
                        warn!(
                            "PR #{} not found on remote and has no workspace, removing local record",
                            pr.pr_number
                        );
                        if let Err(e) = PullRequest::delete(&self.db.pool, &pr.id).await {
                            error!("Failed to delete orphaned local PR: {}", e);
                        }
                    }
                }
                Err(RemoteClientError::Auth) => {
                    debug!("PR sync sweep stopped: not authenticated");
                    return;
                }
                Err(e) => {
                    error!(
                        "Failed to sync PR #{} status to remote: {}",
                        pr.pr_number, e
                    );
                }
            }
        }
    }
}
