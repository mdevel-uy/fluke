use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub const ROLE_DEVELOPER: &str = "developer";
pub const ROLE_ANALYST: &str = "analyst";
pub const ROLE_REVIEWER: &str = "reviewer";

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Worker {
    pub id: Uuid,
    pub name: String,
    pub emoji: String,
    pub soul: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateWorker {
    pub name: String,
    pub emoji: String,
    pub soul: String,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateWorker {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub soul: Option<String>,
    pub role: Option<String>,
}

impl Worker {
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, created_at
               FROM workers
               ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, created_at
               FROM workers
               WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(pool: &SqlitePool, data: &CreateWorker) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let role = data.role.as_deref().unwrap_or(ROLE_DEVELOPER).to_string();
        sqlx::query(
            "INSERT INTO workers (id, name, emoji, soul, role)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(id)
        .bind(&data.name)
        .bind(&data.emoji)
        .bind(&data.soul)
        .bind(&role)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        data: &UpdateWorker,
    ) -> Result<Self, sqlx::Error> {
        let existing = Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let name = data.name.as_ref().unwrap_or(&existing.name);
        let emoji = data.emoji.as_ref().unwrap_or(&existing.emoji);
        let soul = data.soul.as_ref().unwrap_or(&existing.soul);
        let role = data.role.as_ref().unwrap_or(&existing.role);

        sqlx::query(
            "UPDATE workers
                SET name  = ?2,
                    emoji = ?3,
                    soul  = ?4,
                    role  = ?5
              WHERE id = ?1",
        )
        .bind(id)
        .bind(name)
        .bind(emoji)
        .bind(soul)
        .bind(role)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM workers WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Returns true when the worker has at least one task in a state that
    /// would be broken by a role change (in_progress or in_review).
    pub async fn has_in_flight_tasks(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1
                 AND status IN ('in_progress', 'in_review')",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await?;
        Ok(count > 0)
    }

    /// Non-archived workspace attached to the worker. Returns the most
    /// recently updated one if multiple exist.
    pub async fn active_workspace_id(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id
               FROM workspaces
               WHERE worker_id = ?1
                 AND archived = 0
               ORDER BY updated_at DESC
               LIMIT 1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn queued_task_count(pool: &SqlitePool, worker_id: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'queued'",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await
    }

    pub async fn completed_task_count(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1 AND status = 'done'",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await
    }

    /// Attach a workspace to a worker.
    pub async fn attach_workspace(
        pool: &SqlitePool,
        worker_id: Uuid,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE workspaces SET worker_id = ?2 WHERE id = ?1")
            .bind(workspace_id)
            .bind(worker_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Detach a workspace from any worker (sets worker_id to NULL).
    pub async fn detach_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE workspaces SET worker_id = NULL WHERE id = ?1")
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// All non-archived workspaces currently attached to the worker.
    /// Used by the orchestrator to detect and auto-repair orphan
    /// workspaces before applying the capacity guard.
    pub async fn active_workspace_ids(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id
               FROM workspaces
               WHERE worker_id = ?1
                 AND archived = 0",
        )
        .bind(worker_id)
        .fetch_all(pool)
        .await
    }

    /// Worker that owns the given workspace, if any.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT worker_id
               FROM workspaces
               WHERE id = ?1 AND worker_id IS NOT NULL",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }
}
