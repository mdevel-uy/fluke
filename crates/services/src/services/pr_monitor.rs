use std::{sync::Arc, time::Duration};

use api_types::{PullRequestStatus, UpdatePullRequestApiRequest, UpsertPullRequestRequest};
use chrono::Utc;
use db::{
    DBService,
    models::{
        merge::MergeStatus,
        pull_request::PullRequest,
        repo::Repo,
        worker::Worker,
        worker_task::{self, WorkerTask},
        workspace::{Workspace, WorkspaceError},
        workspace_repo::WorkspaceRepo,
    },
};
use git_host::{GitHostError, GitHostProvider, GitHostService, LatestPrReview};
use serde_json::json;
use sqlx::error::Error as SqlxError;
use thiserror::Error;
use tokio::{
    sync::{Notify, RwLock},
    time::interval,
};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::services::{
    analytics::AnalyticsContext,
    config::Config,
    container::ContainerService,
    remote_client::{RemoteClient, RemoteClientError},
    milestone_runs, remote_sync, worker_orchestrator,
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

/// Interpretation of the PR's `statusCheckRollup` from the review-dispatch
/// perspective. Introduced with issue #367: the reviewer no longer burns a
/// round on a PR whose CI is red; the pr_monitor routes to a CI-fix task
/// instead. Any unknown / stale / unfetchable state is folded into `Pending`
/// so the loop always waits for CI to resolve rather than dispatching with
/// uncertain information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CiGate {
    /// Every configured check passed, or no checks are configured — safe to
    /// dispatch the reviewer.
    Green,
    /// At least one check is still running (or the state is unknown / the
    /// fetch failed). Skip both review and CI-fix dispatch this cycle.
    Pending,
    /// A check has failed on this head. Dispatch a CI-fix task to the author
    /// instead of a review.
    Failing,
}

impl CiGate {
    fn from_status(status: &str) -> Self {
        match status {
            // "passing" — every check succeeded.
            // "none" — the repository has no checks configured, which the
            // reviewer checklist treats as "no CI to fail".
            "passing" | "none" => CiGate::Green,
            "failing" => CiGate::Failing,
            // "pending", "unknown", and any future value default to Pending
            // per the sad-path spec of issue #367: never dispatch on
            // uncertain information.
            _ => CiGate::Pending,
        }
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
    poll_notify: Arc<Notify>,
    config: Arc<RwLock<Config>>,
}

impl<C: ContainerService + Send + Sync + 'static> PrMonitorService<C> {
    pub async fn spawn(
        db: DBService,
        analytics: Option<AnalyticsContext>,
        container: C,
        remote_client: Option<RemoteClient>,
        sync_notify: Arc<Notify>,
        poll_notify: Arc<Notify>,
        config: Arc<RwLock<Config>>,
    ) -> tokio::task::JoinHandle<()> {
        let service = Self {
            db,
            poll_interval: Duration::from_secs(60),
            analytics,
            container,
            remote_client,
            sync_notify,
            poll_notify,
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
                // User-requested "refresh now": same full cycle as the tick,
                // without resetting the fixed interval cadence.
                _ = self.poll_notify.notified() => {
                    info!("PR poll triggered externally — running full cycle now");
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
        let tasks = match WorkerTask::find_all_in_progress_with_workspace(&self.db.pool).await {
            Ok(t) => t,
            Err(e) => {
                error!(
                    "Failed to query in-progress tasks for PR adoption sweep: {}",
                    e
                );
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
            let repo = match Repo::find_by_id(&self.db.pool, workspace_repo.repo_id).await {
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

            // PRs live under the remote-facing branch name, which differs
            // from the local one for workspaces created from an existing PR.
            let remote_branch = Workspace::remote_branch_name(&self.db.pool, workspace_id)
                .await
                .unwrap_or_else(|_| workspace.branch.clone());
            let prs = match git_host
                .list_prs_for_branch(&repo.path, &remote.url, &remote_branch)
                .await
            {
                Ok(prs) => prs,
                Err(GitHostError::CliNotInstalled { .. } | GitHostError::NotAGitRepository(_)) => {
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
                    if let Err(e) = worker_orchestrator::on_pr_open_and_push(
                        &self.db,
                        &self.container,
                        workspace_id,
                    )
                    .await
                    {
                        warn!(
                            workspace_id = %workspace_id,
                            "Failed to move task to in_review after PR adoption: {}",
                            e
                        );
                    }

                    // Dispatch a review task for the adopted open PR, unless
                    // its last review verdict still covers the current head.
                    let author_worker_id =
                        Worker::find_by_workspace_id(&self.db.pool, workspace_id)
                            .await
                            .unwrap_or(None);
                    // CI gate (issue #367): the review dispatch path applies
                    // even on the adoption sweep, so a PR adopted with red
                    // (or unresolved) CI does not spend a review round on
                    // something the orchestrator can decide alone. Failing CI
                    // dispatches a fix task to the author; pending/unknown CI
                    // skips both and the next monitor cycle retries.
                    let ci_gate =
                        Self::evaluate_ci_gate(&git_host, &self.db, &pr_info.url, pr_info.number)
                            .await;
                    match ci_gate {
                        CiGate::Pending => {
                            debug!(
                                pr_number = pr_info.number,
                                "CI is pending or unknown at adoption — skipping review/fix dispatch"
                            );
                        }
                        CiGate::Failing => match author_worker_id {
                            Some(author_id) => {
                                if let Err(e) = worker_orchestrator::dispatch_ci_fix_task(
                                    &self.config,
                                    &self.db,
                                    &self.container,
                                    pr_info.number,
                                    workspace_repo.repo_id,
                                    author_id,
                                )
                                .await
                                {
                                    warn!(
                                        pr_number = pr_info.number,
                                        "Failed to dispatch CI-fix task after PR adoption: {}", e
                                    );
                                }
                            }
                            None => {
                                debug!(
                                    pr_number = pr_info.number,
                                    "CI is failing at adoption but no author worker is registered — skipping CI-fix dispatch"
                                );
                            }
                        },
                        CiGate::Green => {
                            if Self::should_dispatch_review(&git_host, &pr_info.url, pr_info.number)
                                .await
                            {
                                if let Err(e) = worker_orchestrator::dispatch_review_task(
                                    &self.config,
                                    &self.db,
                                    &self.container,
                                    pr_info.number,
                                    &pr_info.title,
                                    workspace_repo.repo_id,
                                    author_worker_id,
                                    false,
                                )
                                .await
                                {
                                    warn!(
                                        pr_number = pr_info.number,
                                        "Failed to dispatch review task after PR adoption: {}", e
                                    );
                                }
                            }
                        }
                    }
                }
                MergeStatus::Merged => {
                    if let Err(e) = self
                        .try_archive_workspace(workspace_id, pr_info.number)
                        .await
                    {
                        error!(
                            workspace_id = %workspace_id,
                            "Failed to archive workspace after merged-PR adoption: {}",
                            e
                        );
                    }
                    // Drop stale queued review/fix tasks before the worker
                    // chains into its next task.
                    if let Err(e) = worker_orchestrator::cancel_stale_pr_tasks(
                        &self.db,
                        pr_info.number,
                        workspace_repo.repo_id,
                    )
                    .await
                    {
                        warn!(
                            pr_number = pr_info.number,
                            "Failed to remove stale PR tasks after adoption: {}", e
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
        // Reconcile review-fix tasks whose PR already merged/closed. Their
        // workspaces are not the PR's primary workspace, so `on_pr_merged`
        // never reaches them — without this sweep they sit in_review forever
        // (card showing a MERGED badge that never closes). Runs before the
        // open-PR early return: it is precisely about PRs that are no longer
        // open. Freed workers get offered their next queued task.
        match WorkerTask::complete_review_fix_tasks_for_merged_prs(&self.db.pool).await {
            Ok(completed) => {
                let mut freed_workers: Vec<Uuid> = Vec::new();
                for (task_id, worker_id) in completed {
                    info!(
                        task_id = %task_id,
                        worker_id = %worker_id,
                        "Review-fix task closed: its PR is merged/closed",
                    );
                    if !freed_workers.contains(&worker_id) {
                        freed_workers.push(worker_id);
                    }
                }
                for worker_id in freed_workers {
                    match worker_orchestrator::try_take_next(
                        &self.config,
                        &self.db,
                        &self.container,
                        worker_id,
                    )
                    .await
                    {
                        Ok(_) => info!(
                            worker_id = %worker_id,
                            "Worker took next task after review-fix cleanup",
                        ),
                        Err(e) if e.is_conflict() => {}
                        Err(e) => warn!(
                            worker_id = %worker_id,
                            "Failed to start next task after review-fix cleanup: {}", e
                        ),
                    }
                }
            }
            Err(e) => warn!("Review-fix merged-PR sweep failed: {}", e),
        }

        // Symmetric sweep for reviewer tasks stranded on merged/closed PRs.
        // GitHub rejects reviews on non-open PRs, so a reviewer that hits the
        // merge race keeps retrying forever and blocks the rest of its queue
        // — exactly the incident from issue #468. Runs every poll: idempotent
        // once the first pass has caught the orphans.
        if let Err(e) = worker_orchestrator::cancel_orphan_reviewer_tasks_for_finished_prs(
            &self.config,
            &self.db,
            &self.container,
        )
        .await
        {
            warn!("Reviewer-orphan merged-PR sweep failed: {}", e);
        }

        // Safety net for queues stranded by a missing `try_take_next` trigger
        // — e.g. the cancellation deadlock from #470, or any future finish
        // path that regresses. Any active worker with queued tasks and no
        // in_progress task gets nudged; `try_take_next` swallows the "nothing
        // to do" case, so this is a no-op in steady state.
        if let Err(e) = worker_orchestrator::kickstart_stuck_worker_queues(
            &self.config,
            &self.db,
            &self.container,
        )
        .await
        {
            warn!("Stuck-queue kickstart sweep failed: {}", e);
        }

        // Milestone runs (fluke v2, #666): dispatch the next ready issues of
        // each playing milestone and move to the next wave once merged.
        if let Err(e) = milestone_runs::advance_all(&self.config, &self.db, &self.container).await {
            warn!("Milestone run sweep failed: {}", e);
        }

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

    /// Decide whether a (re-)review should be dispatched for an open PR from
    /// the latest actionable review snapshot:
    /// - no actionable review yet → yes (first round);
    /// - last verdict is APPROVED → no, even if the head moved. A follow-up
    ///   push after approval is a human-driven intervention (issue #471); the
    ///   automatic loop must not re-open a case the reviewer already closed.
    ///   The manual re-request-review path (`dispatch_review_task` with
    ///   `manual: true`) is still available as an explicit override.
    /// - CHANGES_REQUESTED and the head moved → yes (the author pushed fixes,
    ///   the reviewer needs to look again);
    /// - anything else (verdict still covers head, or missing SHAs) → no.
    fn review_due_from_latest(pr_number: i64, latest: Option<&LatestPrReview>) -> bool {
        let Some(review) = latest else {
            return true;
        };
        if review.state == "approved" {
            return false;
        }
        match (&review.reviewed_sha, &review.head_sha) {
            (Some(reviewed), Some(head)) => {
                let has_new_commits = reviewed != head;
                if has_new_commits {
                    info!(
                        pr_number,
                        reviewed_sha = %reviewed,
                        head_sha = %head,
                        state = %review.state,
                        "New commits since last review — re-review warranted",
                    );
                }
                has_new_commits
            }
            _ => false,
        }
    }

    /// Same decision as [`review_due_from_latest`], with a fresh fetch of the
    /// latest review. Conservative on errors: no dispatch this cycle — the
    /// next poll retries.
    async fn should_dispatch_review(
        git_host: &GitHostService,
        pr_url: &str,
        pr_number: i64,
    ) -> bool {
        match git_host.get_pr_latest_review(pr_url).await {
            Ok(latest) => Self::review_due_from_latest(pr_number, latest.as_ref()),
            Err(e) => {
                warn!(
                    pr_number,
                    "Failed to check PR review freshness — skipping dispatch: {}", e
                );
                false
            }
        }
    }

    /// Fetch the PR's current CI rollup, persist it (for the Kanban card), and
    /// return the gate value that drives review/fix dispatch (issue #367). The
    /// reviewer's checklist starts with "CI verde — si algún check está rojo,
    /// request changes sin leer más": the pr_monitor short-circuits that
    /// deterministically so no reviewer round is spent on a broken PR.
    ///
    /// Conservative on error: any failure returns `Pending`, which makes the
    /// caller skip both review and fix dispatch this cycle and retry on the
    /// next poll — never blocks the monitor loop, never dispatches with
    /// uncertain information.
    async fn evaluate_ci_gate(
        git_host: &GitHostService,
        db: &DBService,
        pr_url: &str,
        pr_number: i64,
    ) -> CiGate {
        match git_host.get_pr_ci_status(pr_url).await {
            Ok(ci_status) => {
                if let Err(e) = PullRequest::update_ci_status(&db.pool, pr_url, &ci_status).await {
                    warn!("Failed to persist CI status for PR #{}: {}", pr_number, e);
                }
                CiGate::from_status(&ci_status)
            }
            Err(e) => {
                warn!(
                    pr_number,
                    "Failed to check CI status — treating as pending: {}", e
                );
                CiGate::Pending
            }
        }
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
            // Fetch and persist the CI rollup first so the gate value drives
            // both branches below. Issue #367: the reviewer's own checklist
            // starts with "CI verde — si algún check está rojo, request
            // changes sin leer más", so we short-circuit that deterministically
            // instead of paying a review round for it.
            let ci_gate =
                Self::evaluate_ci_gate(&git_host, &self.db, &pr.pr_url, pr.pr_number).await;

            // PR is still open — reconcile the worker-task state machine.
            // This is idempotent: it only transitions in_progress → in_review
            // for a worker-owned workspace, and no-ops otherwise.
            if let Some(workspace_id) = pr.workspace_id {
                if let Err(e) = worker_orchestrator::on_pr_open_and_push(
                    &self.db,
                    &self.container,
                    workspace_id,
                )
                .await
                {
                    warn!(
                        workspace_id = %workspace_id,
                        "Failed to reconcile worker task on PR open: {}",
                        e
                    );
                }

                // For worker-owned PRs: dispatch a review task (idempotent — the
                // dispatch function guards against duplicates and round caps),
                // but only when the last verdict no longer covers the current
                // head (or there is no review yet).
                if let Some(repo_id) = pr.repo_id {
                    let author_worker_id =
                        Worker::find_by_workspace_id(&self.db.pool, workspace_id)
                            .await
                            .unwrap_or(None);

                    match ci_gate {
                        CiGate::Pending => {
                            debug!(
                                pr_number = pr.pr_number,
                                "CI is pending or unknown — skipping review/fix dispatch this cycle"
                            );
                        }
                        CiGate::Failing => {
                            // Red CI: dispatch a CI-fix task instead of a
                            // review. `dispatch_ci_fix_task` is idempotent per
                            // head SHA and interlocks with any pending
                            // remediation, so a single failing head yields at
                            // most one fix.
                            match author_worker_id {
                                Some(author_id) => {
                                    if let Err(e) = worker_orchestrator::dispatch_ci_fix_task(
                                        &self.config,
                                        &self.db,
                                        &self.container,
                                        pr.pr_number,
                                        repo_id,
                                        author_id,
                                    )
                                    .await
                                    {
                                        warn!(
                                            pr_number = pr.pr_number,
                                            "Failed to dispatch CI-fix task: {}", e
                                        );
                                    }
                                }
                                None => {
                                    debug!(
                                        pr_number = pr.pr_number,
                                        "CI is failing but no author worker is registered for the workspace — skipping CI-fix dispatch"
                                    );
                                }
                            }
                        }
                        CiGate::Green => {
                            // One review snapshot per poll: the latest actionable
                            // verdict, the SHA it was submitted against, and the PR's
                            // current head. Drives BOTH dispatch decisions below —
                            // re-review only when the head moved past the verdict, and
                            // author fix only when the verdict still covers the head.
                            // Conservative on errors: neither dispatch runs this cycle.
                            match git_host.get_pr_latest_review(&pr.pr_url).await {
                                Ok(latest_review) => {
                                    let review_due = Self::review_due_from_latest(
                                        pr.pr_number,
                                        latest_review.as_ref(),
                                    );
                                    if review_due {
                                        if let Err(e) = worker_orchestrator::dispatch_review_task(
                                            &self.config,
                                            &self.db,
                                            &self.container,
                                            pr.pr_number,
                                            &status.title,
                                            repo_id,
                                            author_worker_id,
                                            false,
                                        )
                                        .await
                                        {
                                            warn!(
                                                pr_number = pr.pr_number,
                                                "Failed to dispatch review task: {}", e
                                            );
                                        }
                                    }

                                    if let Some(review) = &latest_review {
                                        let state = review.state.as_str();
                                        // Whether the verdict was made on the PR's current
                                        // head. Once the author pushes past it, the verdict
                                        // is stale: the PR is waiting for a re-review.
                                        let verdict_covers_head = matches!(
                                            (&review.reviewed_sha, &review.head_sha),
                                            (Some(reviewed), Some(head)) if reviewed == head
                                        );

                                        // Persist verdict on the developer's worker task so
                                        // the Kanban card can show it without polling GitHub.
                                        // Only a verdict that covers the head is shown: a
                                        // stale "changes requested" between the fix push and
                                        // the re-review reads as work still owed when the
                                        // PR is actually waiting for review.
                                        let shown = verdict_covers_head.then_some(state);
                                        match WorkerTask::find_by_workspace(
                                            &self.db.pool,
                                            workspace_id,
                                        )
                                        .await
                                        {
                                            Ok(Some(dev_task)) => {
                                                if dev_task.review_result.as_deref() != shown {
                                                    if let Err(e) = WorkerTask::set_review_result(
                                                        &self.db.pool,
                                                        dev_task.id,
                                                        shown,
                                                    )
                                                    .await
                                                    {
                                                        warn!(
                                                            pr_number = pr.pr_number,
                                                            "Failed to persist review_result: {}",
                                                            e
                                                        );
                                                    }
                                                }

                                                // Auto-transition in_review → approved once the
                                                // verdict is on file. Guarded on the current status
                                                // so a follow-up commit (already back to in_review
                                                // by the human via re_request_review) is not silently
                                                // flipped back to approved. Idempotent: if the DB
                                                // write fails, the next poll retries — the task
                                                // stays in in_review with review_result='approved'.
                                                if state == "approved"
                                                    && dev_task.status
                                                        == worker_task::STATUS_IN_REVIEW
                                                {
                                                    if let Err(e) = WorkerTask::set_status(
                                                        &self.db.pool,
                                                        dev_task.id,
                                                        worker_task::STATUS_APPROVED,
                                                    )
                                                    .await
                                                    {
                                                        warn!(
                                                            pr_number = pr.pr_number,
                                                            task_id = %dev_task.id,
                                                            "Failed to transition task to approved: {}", e
                                                        );
                                                    }
                                                }
                                            }
                                            Ok(None) => {}
                                            Err(e) => warn!(
                                                pr_number = pr.pr_number,
                                                "Failed to look up dev task for review_result: {}",
                                                e
                                            ),
                                        }

                                        // Dispatch remediation only while the verdict covers
                                        // the CURRENT head. Once the author pushes, the
                                        // changes-request is stale — the next step is a
                                        // re-review, not another fix on top of the fix.
                                        if state == "changes_requested" && verdict_covers_head {
                                            match Worker::find_by_workspace_id(
                                                &self.db.pool,
                                                workspace_id,
                                            )
                                            .await
                                            {
                                                Ok(Some(author_id)) => {
                                                    if let Err(e) =
                                                worker_orchestrator::dispatch_author_fix_task(
                                                    &self.config,
                                                    &self.db,
                                                    &self.container,
                                                    pr.pr_number,
                                                    repo_id,
                                                    author_id,
                                                )
                                                .await
                                            {
                                                warn!(
                                                    pr_number = pr.pr_number,
                                                    "Failed to dispatch author fix task: {}", e
                                                );
                                            }
                                                }
                                                Ok(None) => {}
                                                Err(e) => warn!(
                                                    pr_number = pr.pr_number,
                                                    "Failed to look up author worker for fix dispatch: {}",
                                                    e
                                                ),
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    if !matches!(
                                        e,
                                        GitHostError::CliNotInstalled { .. }
                                            | GitHostError::NotAGitRepository(_)
                                    ) {
                                        warn!(
                                            pr_number = pr.pr_number,
                                            "Failed to check PR review state: {}", e
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Poll mergeable state non-fatally — a failure here must not break pr_monitor.
            match git_host.get_pr_mergeable(&pr.pr_url).await {
                Ok(mergeable) => {
                    let previous = pr.pr_mergeable.clone();
                    if previous.as_deref() != Some(mergeable.as_str()) {
                        debug!(
                            "PR #{} mergeable state: {} (was {:?})",
                            pr.pr_number, mergeable, previous
                        );
                        if let Err(e) =
                            PullRequest::update_mergeable(&self.db.pool, &pr.pr_url, &mergeable)
                                .await
                        {
                            warn!(
                                "Failed to persist mergeable state for PR #{}: {}",
                                pr.pr_number, e
                            );
                        }
                    }

                    // Issue #370: on the transition INTO `conflicting`, attempt
                    // the merge server-side. If it comes out clean (stale
                    // GitHub rollup — common) we push and the next poll flips
                    // mergeable back to `mergeable` without ever dispatching
                    // an agent. Real conflicts are left as-is; the "Fix merge
                    // conflicts" quick action handles the agent hand-off
                    // (with the pre-merge already primed, per the UI path).
                    let transitioned_into_conflicting =
                        mergeable == "conflicting" && previous.as_deref() != Some("conflicting");
                    if transitioned_into_conflicting {
                        self.try_pre_merge_conflicting_pr(pr).await;
                    }
                }
                Err(e) => {
                    warn!(
                        "Failed to check mergeable state for PR #{}: {}",
                        pr.pr_number, e
                    );
                }
            }

            // CI status was already fetched, persisted, and gated on above
            // (see `evaluate_ci_gate`) — deliberately not re-polled here.

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

        // A merged or closed PR invalidates any queued review/fix tasks that
        // reference it — drop them before any worker picks them up.
        if matches!(&status.status, MergeStatus::Merged | MergeStatus::Closed)
            && let Some(repo_id) = pr.repo_id
        {
            if let Err(e) =
                worker_orchestrator::cancel_stale_pr_tasks(&self.db, pr.pr_number, repo_id).await
            {
                warn!(
                    pr_number = pr.pr_number,
                    "Failed to remove stale PR tasks: {}", e
                );
            }
        }

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

    /// Attempt to merge `<remote>/<target_branch>` into the PR's workspace
    /// worktree when the mergeable rollup first flips to `conflicting`.
    ///
    /// On a clean merge (GitHub's rollup was stale) the merge commit is
    /// pushed via the standard push path so the next monitor cycle sees
    /// `mergeable` and no agent is ever dispatched. On real conflicts the
    /// worktree is left with the merge in progress; the UI "Fix merge
    /// conflicts" quick action picks that up and dispatches the agent with
    /// the file list already inline. On any environmental failure the state
    /// is left untouched (the git service guarantees the worktree is not
    /// corrupted) and the classic dispatch path stays available as a
    /// fallback.
    ///
    /// Any error is logged and swallowed — this is a best-effort optimization
    /// on top of the mergeable poll, never a source of pr_monitor breakage.
    async fn try_pre_merge_conflicting_pr(&self, pr: &PullRequest) {
        let Some(workspace_id) = pr.workspace_id else {
            return;
        };
        let Some(repo_id) = pr.repo_id else {
            return;
        };

        let workspace = match Workspace::find_by_id(&self.db.pool, workspace_id).await {
            Ok(Some(ws)) => ws,
            Ok(None) => return,
            Err(e) => {
                warn!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    "Pre-merge skipped: failed to load workspace: {}", e
                );
                return;
            }
        };

        // Only attempt pre-merge when the workspace is materialized. Archived
        // workspaces (no container_ref) go straight to the fallback path when
        // the user later clicks "Fix merge conflicts".
        let Some(container_ref) = workspace.container_ref.clone() else {
            debug!(
                workspace_id = %workspace_id,
                pr_number = pr.pr_number,
                "Pre-merge skipped: workspace has no container_ref"
            );
            return;
        };

        let repo = match Repo::find_by_id(&self.db.pool, repo_id).await {
            Ok(Some(r)) => r,
            Ok(None) => {
                warn!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    "Pre-merge skipped: repo {} not found", repo_id
                );
                return;
            }
            Err(e) => {
                warn!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    "Pre-merge skipped: failed to load repo: {}", e
                );
                return;
            }
        };

        let worktree_path = std::path::PathBuf::from(&container_ref).join(&repo.name);
        let git = self.container.git();
        let remote = match git.resolve_remote_for_branch(&repo.path, &pr.target_branch_name) {
            Ok(r) => r,
            Err(e) => {
                warn!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    "Pre-merge skipped: failed to resolve remote for target branch: {}", e
                );
                return;
            }
        };

        let outcome = match git.pre_merge_target_branch(
            &worktree_path,
            &remote.url,
            &remote.name,
            &pr.target_branch_name,
        ) {
            Ok(o) => o,
            Err(e) => {
                warn!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    "Pre-merge attempt failed — leaving PR in conflicting state for the fallback path: {}",
                    e
                );
                return;
            }
        };

        match outcome {
            git::PreMergeOutcome::Clean { merge_commit_sha } => {
                let worker_pat = match Worker::find_github_pat_by_workspace_id(
                    &self.db.pool,
                    workspace_id,
                )
                .await
                {
                    Ok(pat) => pat,
                    Err(e) => {
                        warn!(
                            workspace_id = %workspace_id,
                            pr_number = pr.pr_number,
                            "Pre-merge clean: failed to load worker PAT — trying anyway: {}", e
                        );
                        None
                    }
                };

                let remote_branch = match Workspace::remote_branch_name(&self.db.pool, workspace_id)
                    .await
                {
                    Ok(name) => name,
                    Err(e) => {
                        warn!(
                            workspace_id = %workspace_id,
                            pr_number = pr.pr_number,
                            "Pre-merge clean: failed to resolve remote branch — leaving unpushed: {}",
                            e
                        );
                        return;
                    }
                };

                match git.push_to_remote_with_token(
                    &worktree_path,
                    &workspace.branch,
                    &remote_branch,
                    false,
                    worker_pat.as_deref(),
                ) {
                    Ok(()) => {
                        info!(
                            workspace_id = %workspace_id,
                            pr_number = pr.pr_number,
                            merge_commit_sha = %merge_commit_sha,
                            "Pre-merge produced a clean merge; pushed without dispatching agent"
                        );
                    }
                    Err(e) => {
                        warn!(
                            workspace_id = %workspace_id,
                            pr_number = pr.pr_number,
                            "Pre-merge clean but push failed: {}", e
                        );
                    }
                }
            }
            git::PreMergeOutcome::Conflicts { conflicted_files } => {
                info!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    conflicted_files = conflicted_files.len(),
                    "Pre-merge stopped with conflicts; worktree primed for agent dispatch via UI"
                );
            }
            git::PreMergeOutcome::AlreadyPrimed { conflicted_files } => {
                // A previous transition already primed this worktree and no
                // one has resolved it yet; nothing to do here. The UI quick
                // action will detect the primed state and dispatch with the
                // same file list.
                info!(
                    workspace_id = %workspace_id,
                    pr_number = pr.pr_number,
                    conflicted_files = conflicted_files.len(),
                    "Pre-merge found merge already primed from a prior run; leaving worktree untouched"
                );
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    // The gate values are the contract between the CI-status strings emitted
    // by `git_host::get_pr_ci_status` and the pr_monitor dispatch routing.
    // "passing" and "none" MUST be `Green` so a PR with no configured checks
    // (or all-green checks) advances to review; "failing" MUST be `Failing`
    // so the CI-fix path fires; everything else — including "pending",
    // "unknown", or any future value not yet in the enum — MUST fall through
    // to `Pending` (issue #367 sad path: never dispatch on uncertain info).
    #[test]
    fn ci_gate_maps_known_states_to_expected_verdicts() {
        assert_eq!(CiGate::from_status("passing"), CiGate::Green);
        assert_eq!(CiGate::from_status("none"), CiGate::Green);
        assert_eq!(CiGate::from_status("failing"), CiGate::Failing);
    }

    #[test]
    fn ci_gate_conservative_defaults_treat_uncertain_as_pending() {
        assert_eq!(CiGate::from_status("pending"), CiGate::Pending);
        assert_eq!(CiGate::from_status("unknown"), CiGate::Pending);
        // Any future/unrecognised value must also fold into Pending so the
        // monitor loop skips this cycle rather than dispatching on stale info.
        assert_eq!(CiGate::from_status("weird_new_state"), CiGate::Pending);
        assert_eq!(CiGate::from_status(""), CiGate::Pending);
    }
}
