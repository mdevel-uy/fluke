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
    pub created_at: DateTime<Utc>,
    /// The TL reviewer's verdict for this task's PR: 'approved' | 'changes_requested' | NULL.
    pub review_result: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateWorkerTask {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub issue_number: Option<i64>,
    pub skills: Vec<String>,
}

impl WorkerTask {
    pub async fn list_by_worker(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
                  issue_number, status, skills)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8)",
        )
        .bind(id)
        .bind(worker_id)
        .bind(data.repo_id)
        .bind(next_position)
        .bind(&data.title)
        .bind(&data.prompt)
        .bind(data.issue_number)
        .bind(&skills_json)
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'queued'
               ORDER BY position ASC, created_at ASC
               LIMIT 1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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

    /// Count all reviewer-role tasks ever dispatched for a given PR (by
    /// `pr_number` stored in `issue_number`). Used to enforce the review-round cap.
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
                 AND wt.repo_id = ?2",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await
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
                    wt.issue_number, wt.status, wt.workspace_id, wt.skills, wt.created_at,
                    wt.review_result
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
                    issue_number, status, workspace_id, skills, created_at,
                    review_result
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
        sqlx::query("UPDATE worker_tasks SET status = ?2 WHERE id = ?1")
            .bind(id)
            .bind(status)
            .execute(pool)
            .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Persist the TL reviewer's verdict on the developer's task so the UI
    /// can surface it without polling GitHub. `result` is 'approved',
    /// 'changes_requested', or 'failed' (the reviewer worker itself crashed).
    /// Pass `None` to clear the field.
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

    /// Find the developer's worker task for the given PR by joining
    /// `pull_requests` on `workspace_id`. Used when we only have the
    /// reviewer's task context (which carries the PR number in
    /// `issue_number`) and need to surface a verdict on the dev's card.
    pub async fn find_developer_task_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT wt.id, wt.worker_id, wt.repo_id, wt.position, wt.title, wt.prompt,
                    wt.issue_number, wt.status, wt.workspace_id, wt.skills, wt.created_at,
                    wt.review_result
               FROM worker_tasks wt
               JOIN pull_requests pr ON wt.workspace_id = pr.workspace_id
               JOIN workers w ON wt.worker_id = w.id
               WHERE w.role = 'developer'
                 AND pr.pr_number = ?1
                 AND pr.repo_id = ?2
               ORDER BY wt.created_at DESC
               LIMIT 1",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_optional(pool)
        .await
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
