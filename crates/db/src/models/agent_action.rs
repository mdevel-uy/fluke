use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_SKIPPED: &str = "skipped";

/// One declarative action written by an agent to `.vk/actions.json`
/// (AGENT-ACTIONS-SPEC.md, F1).
///
/// The row is the outbox entry the orchestrator drains against GitHub: the
/// agent produces content, the system produces effects. `UNIQUE (task_id,
/// seq)` is the structural idempotency key — re-ingesting the same file is
/// a no-op, and surgical retry only touches `pending` / `failed` rows.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentAction {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub repo_id: Uuid,
    /// Position of the action within the agent's declared array.
    pub seq: i64,
    pub kind: String,
    /// Raw JSON of the action as declared by the agent.
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    /// Issue / milestone / PR number produced or touched by the action.
    pub result_number: Option<i64>,
    pub result_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateAgentAction {
    pub task_id: Uuid,
    pub repo_id: Uuid,
    pub seq: i64,
    pub kind: String,
    pub payload: String,
}

const COLS: &str = "id, task_id, repo_id, seq, kind, payload, status, \
                    attempts, last_error, result_number, result_url, \
                    created_at, updated_at";

impl AgentAction {
    /// Insert a new row. `INSERT OR IGNORE` gives idempotency against the
    /// `UNIQUE (task_id, seq)` key so re-ingesting the same file is a no-op.
    /// Returns the row that ended up in the DB (the pre-existing one if the
    /// insert was ignored).
    pub async fn create(pool: &SqlitePool, data: &CreateAgentAction) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT OR IGNORE INTO agent_actions
                 (id, task_id, repo_id, seq, kind, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(id)
        .bind(data.task_id)
        .bind(data.repo_id)
        .bind(data.seq)
        .bind(&data.kind)
        .bind(&data.payload)
        .execute(pool)
        .await?;

        sqlx::query_as::<_, AgentAction>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM agent_actions
              WHERE task_id = ?1 AND seq = ?2"
        )))
        .bind(data.task_id)
        .bind(data.seq)
        .fetch_optional(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn find_by_task_id(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AgentAction>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM agent_actions
              WHERE task_id = ?1
              ORDER BY seq ASC"
        )))
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Rows the drain (or a surgical retry) still needs to execute. Excludes
    /// `done` and `skipped` so retry never re-runs an already-effective
    /// action.
    pub async fn find_pending_or_failed_for_task(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AgentAction>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM agent_actions
              WHERE task_id = ?1 AND status IN ('pending', 'failed')
              ORDER BY seq ASC"
        )))
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Mark an action executed against GitHub. `result_number` / `result_url`
    /// feed back into placeholder resolution for later actions.
    pub async fn set_done(
        pool: &SqlitePool,
        id: Uuid,
        result_number: Option<i64>,
        result_url: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE agent_actions
                SET status = 'done',
                    result_number = ?2,
                    result_url = ?3,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(result_number)
        .bind(result_url)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Definitive failure: records the error and halts the drain. `attempts`
    /// is caller-supplied so the counter stays consistent when set from the
    /// drain loop that already tracked the retry.
    pub async fn set_failed(
        pool: &SqlitePool,
        id: Uuid,
        error: &str,
        attempts: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE agent_actions
                SET status = 'failed',
                    last_error = ?2,
                    attempts = ?3,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(error)
        .bind(attempts)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn increment_attempts(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE agent_actions
                SET attempts = attempts + 1,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn count_failed_for_task(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agent_actions
              WHERE task_id = ?1 AND status = 'failed'",
        )
        .bind(task_id)
        .fetch_one(pool)
        .await
    }
}
