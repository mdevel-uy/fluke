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
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateWorkerTask {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub issue_number: Option<i64>,
}

impl WorkerTask {
    pub async fn list_by_worker(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, created_at
               FROM worker_tasks
               WHERE worker_id = ?1
               ORDER BY position ASC, created_at ASC",
        )
        .bind(worker_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, created_at
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

        sqlx::query(
            "INSERT INTO worker_tasks
                 (id, worker_id, repo_id, position, title, prompt,
                  issue_number, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued')",
        )
        .bind(id)
        .bind(worker_id)
        .bind(data.repo_id)
        .bind(next_position)
        .bind(&data.title)
        .bind(&data.prompt)
        .bind(data.issue_number)
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

    /// Task currently in progress for the worker, if any.
    pub async fn find_in_progress(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, created_at
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
                    issue_number, status, workspace_id, created_at
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'queued'
               ORDER BY position ASC, created_at ASC
               LIMIT 1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn count_in_review(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'in_review'",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await
    }

    /// The task associated with a given workspace, if any.
    pub async fn find_by_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, created_at
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
}
