use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_IN_PROGRESS: &str = "in_progress";
pub const STATUS_IN_REVIEW: &str = "in_review";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

pub fn is_valid_status(value: &str) -> bool {
    matches!(
        value,
        STATUS_QUEUED | STATUS_IN_PROGRESS | STATUS_IN_REVIEW | STATUS_DONE | STATUS_FAILED
    )
}

/// `failure_kind` value for tasks whose coding agent never really ran —
/// the CLI died on an API error (rate limit, model not available, auth).
/// These do not consume review rounds and are retried with backoff.
pub const FAILURE_KIND_INFRA: &str = "infra";

/// Task created from the kanban board or by the orchestrator itself.
pub const SOURCE_KANBAN: &str = "kanban";
/// Ad-hoc request submitted from the Analyst Desk screen.
pub const SOURCE_DESK: &str = "desk";

pub fn is_valid_source(value: &str) -> bool {
    matches!(value, SOURCE_KANBAN | SOURCE_DESK)
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct WorkerTask {
    pub id: Uuid,
    pub worker_id: Uuid,
    pub repo_id: Uuid,
    pub position: i64,
    pub title: String,
    pub prompt: String,
    pub issue_number: Option<i64>,
    pub status: String,
    pub workspace_id: Option<Uuid>,
    /// JSON-encoded array of skill names selected for this task.
    pub skills: String,
    /// Origin of the task: `kanban` or `desk`.
    pub source: String,
    pub created_at: DateTime<Utc>,
    /// The TL reviewer's verdict for this task's PR: 'approved' | 'changes_requested' | NULL.
    pub review_result: Option<String>,
    /// Human-readable reason recorded when the task transitioned to
    /// 'failed'. NULL for non-failed tasks (cleared on any transition away
    /// from 'failed', e.g. a re-queue).
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateWorkerTask {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub issue_number: Option<i64>,
    pub skills: Vec<String>,
    pub source: String,
}

impl WorkerTask {
    pub async fn list_by_worker(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE worker_id = ?1
               ORDER BY position ASC, created_at ASC",
        )
        .bind(worker_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    /// Append a task at the end of the worker's queue.
    pub async fn append(
        pool: &SqlitePool,
        worker_id: Uuid,
        data: &CreateWorkerTask,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let next_position: i64 = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(position), -1) + 1
               FROM worker_tasks
               WHERE worker_id = ?1",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await?;

        let skills_json = serde_json::to_string(&data.skills).unwrap_or_else(|_| "[]".to_string());

        sqlx::query(
            "INSERT INTO worker_tasks
                 (id, worker_id, repo_id, position, title, prompt,
                  issue_number, status, skills, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9)",
        )
        .bind(id)
        .bind(worker_id)
        .bind(data.repo_id)
        .bind(next_position)
        .bind(&data.title)
        .bind(&data.prompt)
        .bind(data.issue_number)
        .bind(&skills_json)
        .bind(&data.source)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Update mutable fields. Returns the updated row.
    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        position: Option<i64>,
        status: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        let existing = Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let new_position = position.unwrap_or(existing.position);
        let new_status = status.unwrap_or(&existing.status);

        sqlx::query(
            "UPDATE worker_tasks
                SET position = ?2,
                    status   = ?3
              WHERE id = ?1",
        )
        .bind(id)
        .bind(new_position)
        .bind(new_status)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM worker_tasks WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// All in_progress tasks across all workers. Used at startup to detect
    /// tasks whose agent was killed by a server restart.
    pub async fn find_all_in_progress(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE status = 'in_progress'",
        )
        .fetch_all(pool)
        .await
    }

    /// Task currently in progress for the worker, if any.
    pub async fn find_in_progress(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'in_progress'
               ORDER BY position ASC, created_at ASC
               LIMIT 1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await
    }

    /// Next queued task for the worker (lowest position, oldest first).
    pub async fn find_next_queued(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'queued'
               ORDER BY position ASC, created_at ASC
               LIMIT 1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await
    }

    /// Atomically claim a queued task for its worker: flips it to
    /// `in_progress` only while it is still `queued` and the worker has no
    /// other `in_progress` task. SQLite serializes writes, so exactly one
    /// of several concurrent claimers succeeds; the rest get `false`.
    pub async fn try_claim(
        pool: &SqlitePool,
        id: Uuid,
        worker_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE worker_tasks
                SET status = 'in_progress'
              WHERE id = ?1
                AND status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM worker_tasks
                   WHERE worker_id = ?2 AND status = 'in_progress'
                )",
        )
        .bind(id)
        .bind(worker_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Undo [`Self::try_claim`] after a failed start: put the task back to
    /// `queued`, but only while the claim never got far enough to link a
    /// workspace — a linked task belongs to a live run and must not be
    /// silently re-queued.
    pub async fn release_claim(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE worker_tasks
                SET status = 'queued'
              WHERE id = ?1
                AND status = 'in_progress'
                AND workspace_id IS NULL",
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn count_in_review(pool: &SqlitePool, worker_id: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'in_review'",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await
    }

    /// All in-progress tasks that have a workspace assigned (across all workers).
    /// Used by the pr_monitor to sweep for PRs created outside the app.
    pub async fn find_all_in_progress_with_workspace(
        pool: &SqlitePool,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE status = 'in_progress' AND workspace_id IS NOT NULL",
        )
        .fetch_all(pool)
        .await
    }

    /// The task associated with a given workspace, if any.
    pub async fn find_by_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE workspace_id = ?1
               LIMIT 1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn set_workspace_id(
        pool: &SqlitePool,
        id: Uuid,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE worker_tasks SET workspace_id = ?2 WHERE id = ?1")
            .bind(id)
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Delete all active (queued / in_progress / in_review) tasks linked to
    /// the given workspace. Called when a workspace is hard-deleted so orphaned
    /// tasks do not leave cards stuck on the kanban board. Idempotent: returns
    /// 0 if no matching tasks exist.
    pub async fn delete_active_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "DELETE FROM worker_tasks
               WHERE workspace_id = ?1
                 AND status IN ('queued', 'in_progress', 'in_review')",
        )
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Clear the workspace_id link for every task that points at a given
    /// workspace. Used during orchestrator rollback so a failed start does
    /// not leave dangling references to an archived workspace.
    pub async fn clear_workspace_link(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE worker_tasks SET workspace_id = NULL WHERE workspace_id = ?1")
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// True when the given workspace has a task with status in
    /// (`in_progress`, `in_review`). Used to distinguish healthy workspaces
    /// from orphans left behind by a failed start.
    pub async fn workspace_has_active_task(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE workspace_id = ?1
                 AND status IN ('in_progress', 'in_review')",
        )
        .bind(workspace_id)
        .fetch_one(pool)
        .await?;
        Ok(count > 0)
    }

    /// Count reviewer-role tasks dispatched for a given PR (by `pr_number`
    /// stored in `issue_number`) that consume a review round. Tasks that
    /// failed for infrastructure reasons (`failure_kind = 'infra'`: the agent
    /// never really ran) are excluded — an API outage must not burn the PR's
    /// round budget. Used to enforce the review-round cap.
    pub async fn count_reviewer_tasks_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number = ?1
                 AND wt.repo_id = ?2
                 AND NOT (wt.status = 'failed'
                          AND COALESCE(wt.failure_kind, '') = 'infra')",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
    }

    /// Count the run of infra-failed reviewer tasks for a PR that happened
    /// *after* the last reviewer task that actually ran (or over the whole
    /// history when nothing ever ran). This is the consecutive-retry counter
    /// that drives the dispatch backoff and the model fallback; a round that
    /// really executes resets it to zero.
    pub async fn count_trailing_infra_failures_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number = ?1
                 AND wt.repo_id = ?2
                 AND wt.status = 'failed'
                 AND wt.failure_kind = 'infra'
                 AND wt.created_at > COALESCE(
                       (SELECT MAX(wt2.created_at)
                          FROM worker_tasks wt2
                          JOIN workers w2 ON wt2.worker_id = w2.id
                          WHERE w2.role = 'reviewer'
                            AND wt2.issue_number = ?1
                            AND wt2.repo_id = ?2
                            AND NOT (wt2.status = 'failed'
                                     AND COALESCE(wt2.failure_kind, '') = 'infra')),
                       '1970-01-01')",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
    }

    /// Timestamp of the most recent infra-failed reviewer task for a PR.
    /// `created_at` is a good-enough proxy for the failure time: infra
    /// failures die within seconds of dispatch.
    pub async fn last_infra_failure_at_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
            "SELECT MAX(wt.created_at)
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number = ?1
                 AND wt.repo_id = ?2
                 AND wt.status = 'failed'
                 AND wt.failure_kind = 'infra'",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
    }

    /// Review-loop activity per PR: `(repo_id, pr_number)` → `"queued"` |
    /// `"running"` for every reviewer task currently queued or in progress.
    /// Feeds the workspace summaries so the UI can show "reviewer working /
    /// waiting for automatic review" instead of silence until a verdict.
    pub async fn reviewer_activity_by_pr(
        pool: &SqlitePool,
    ) -> Result<HashMap<(Uuid, i64), String>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (Uuid, i64, String)>(
            "SELECT wt.repo_id, wt.issue_number, wt.status
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number IS NOT NULL
                 AND wt.status IN ('queued', 'in_progress')",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(repo_id, pr_number, status)| {
                let activity = if status == STATUS_IN_PROGRESS {
                    "running"
                } else {
                    "queued"
                };
                ((repo_id, pr_number), activity.to_string())
            })
            .collect())
    }

    /// Return the first active (queued / in_progress / in_review) reviewer task
    /// for a given PR. Used as a duplicate-dispatch guard.
    pub async fn find_active_reviewer_task_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT wt.id, wt.worker_id, wt.repo_id, wt.position, wt.title, wt.prompt,
                    wt.issue_number, wt.status, wt.workspace_id, wt.skills, wt.source,
                    wt.created_at, wt.review_result, wt.failure_reason
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number = ?1
                 AND wt.repo_id = ?2
                 AND wt.status IN ('queued', 'in_progress', 'in_review')
               ORDER BY wt.created_at ASC
               LIMIT 1",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_optional(pool)
        .await
    }

    /// Count DONE reviewer tasks for a given PR. Used to determine how many
    /// review rounds have actually completed (vs. been dispatched).
    pub async fn count_reviewer_tasks_done_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'reviewer'
                 AND wt.issue_number = ?1
                 AND wt.repo_id = ?2
                 AND wt.status = 'done'",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
    }

    /// Count ALL fix tasks ever dispatched to an author for a given PR
    /// (regardless of status). Used alongside `count_reviewer_tasks_done_for_pr`
    /// to prevent duplicate fix dispatches across poll cycles.
    pub async fn count_all_author_fix_tasks_for_pr(
        pool: &SqlitePool,
        worker_id: Uuid,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1
                 AND issue_number = ?2
                 AND repo_id = ?3",
        )
        .bind(worker_id)
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
    }

    /// Delete queued tasks referencing a PR (`pr_number` stored in
    /// `issue_number`): dispatched review rounds and author fix tasks that
    /// never started. Once the PR is merged or closed they are stale.
    /// GitHub issues and PRs share one number sequence, so `issue_number ==
    /// pr_number` can only refer to this PR. In-progress tasks are untouched.
    pub async fn delete_queued_tasks_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "DELETE FROM worker_tasks
               WHERE issue_number = ?1
                 AND repo_id = ?2
                 AND status = 'queued'",
        )
        .bind(pr_number)
        .bind(repo_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Find the first active task (queued, in_progress, or in_review) for the
    /// given repo and issue number, across all workers. Used to detect duplicate
    /// issue assignments before creating a new task.
    pub async fn find_active_by_issue(
        pool: &SqlitePool,
        repo_id: Uuid,
        issue_number: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE repo_id = ?1
                 AND issue_number = ?2
                 AND status IN ('queued', 'in_progress', 'in_review')
               ORDER BY created_at ASC
               LIMIT 1",
        )
        .bind(repo_id)
        .bind(issue_number)
        .fetch_optional(pool)
        .await
    }

    /// Set status without changing position. Returns the updated row.
    pub async fn set_status(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
    ) -> Result<Self, sqlx::Error> {
        // Any transition away from 'failed' clears the stale failure reason
        // and kind (a re-queued task starts clean).
        sqlx::query(
            "UPDATE worker_tasks
                SET status = ?2,
                    failure_reason = CASE WHEN ?2 = 'failed' THEN failure_reason ELSE NULL END,
                    failure_kind = CASE WHEN ?2 = 'failed' THEN failure_kind ELSE NULL END
              WHERE id = ?1",
        )
        .bind(id)
        .bind(status)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Transition to 'failed' recording why. The reason is what the UI shows
    /// on the failed card — keep it short, actionable and human-readable.
    pub async fn set_failed(
        pool: &SqlitePool,
        id: Uuid,
        reason: &str,
    ) -> Result<Self, sqlx::Error> {
        Self::set_failed_with_kind(pool, id, reason, None).await
    }

    /// Like [`Self::set_failed`], additionally recording the failure kind.
    /// Pass `Some(FAILURE_KIND_INFRA)` when the agent never really ran (API
    /// error) so the task is excluded from review-round accounting; `None`
    /// for genuine agent failures.
    pub async fn set_failed_with_kind(
        pool: &SqlitePool,
        id: Uuid,
        reason: &str,
        kind: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "UPDATE worker_tasks
                SET status = 'failed', failure_reason = ?2, failure_kind = ?3
              WHERE id = ?1",
        )
        .bind(id)
        .bind(reason)
        .bind(kind)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Force a specific model for this task, overriding the worker's own
    /// model when the run starts. Used by the dispatcher to degrade to a
    /// known-good model after repeated infra failures.
    pub async fn set_model_override(
        pool: &SqlitePool,
        id: Uuid,
        model: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE worker_tasks SET model_override = ?2 WHERE id = ?1")
            .bind(id)
            .bind(model)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// The model forced for this task by the dispatcher, if any.
    pub async fn model_override(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT model_override FROM worker_tasks WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
    }

    /// Persist the TL reviewer's verdict on the developer's task so the UI
    /// can surface it without polling GitHub. `result` is 'approved' or
    /// 'changes_requested'. Pass `None` to clear a stale verdict when a new
    /// review round is dispatched.
    pub async fn set_review_result(
        pool: &SqlitePool,
        id: Uuid,
        result: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE worker_tasks SET review_result = ?2 WHERE id = ?1")
            .bind(id)
            .bind(result)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Atomically move a queued task from its current worker to `target_worker_id`
    /// at the end of the target's queue. Wrapped in a transaction so the move
    /// is a single logical step — no window in which the task belongs to no
    /// worker (or to both). Returns `Some(updated_task)` on success, or `None`
    /// when the task no longer exists or is not `queued` at the moment the
    /// transaction runs (caller should re-read to surface a precise reason).
    pub async fn reassign_if_queued(
        pool: &SqlitePool,
        id: Uuid,
        target_worker_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let mut tx = pool.begin().await?;

        let next_position: i64 = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(position), -1) + 1
               FROM worker_tasks
               WHERE worker_id = ?1",
        )
        .bind(target_worker_id)
        .fetch_one(&mut *tx)
        .await?;

        let rows = sqlx::query(
            "UPDATE worker_tasks
                SET worker_id = ?2,
                    position  = ?3
              WHERE id = ?1
                AND status = 'queued'",
        )
        .bind(id)
        .bind(target_worker_id)
        .bind(next_position)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        if rows == 0 {
            tx.rollback().await?;
            return Ok(None);
        }

        let updated = sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, source,
                    created_at, review_result, failure_reason
               FROM worker_tasks
               WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(updated)
    }

    /// Reset a task to `queued` at the front of its worker's queue (lowest
    /// position - 1) and clear its workspace link. Used during startup
    /// recovery to re-queue tasks whose execution was killed by a restart.
    pub async fn re_queue_at_front(pool: &SqlitePool, id: Uuid) -> Result<Self, sqlx::Error> {
        let task = Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let min_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MIN(position), 0) FROM worker_tasks WHERE worker_id = ?1",
        )
        .bind(task.worker_id)
        .fetch_one(pool)
        .await?;

        sqlx::query(
            "UPDATE worker_tasks SET status = 'queued', position = ?2, workspace_id = NULL
               WHERE id = ?1",
        )
        .bind(id)
        .bind(min_pos - 1)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }
}
