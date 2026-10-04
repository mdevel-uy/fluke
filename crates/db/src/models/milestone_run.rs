//! Play por milestone (fluke v2, #666). A run dispatches the issues of one
//! GitHub milestone wave by wave; the engine lives in
//! `services::milestone_runs`. One row per (repo, milestone): resetting a run
//! deletes it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

pub const STATUS_RUNNING: &str = "running";
pub const STATUS_PAUSED: &str = "paused";
pub const STATUS_WAITING: &str = "waiting";
pub const STATUS_DONE: &str = "done";

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct MilestoneRun {
    pub id: Uuid,
    pub repo_id: Uuid,
    pub milestone: String,
    /// `running | paused | waiting | done`.
    pub status: String,
    /// Pause when a wave finishes instead of starting the next one.
    pub step_mode: bool,
    /// Wave being worked on; `None` before the first sweep.
    #[ts(type = "number | null")]
    pub current_wave: Option<i64>,
    /// Why a `waiting` run is stopped: `decision:<n>`, `failed:<n>` or
    /// `designer:<n>` (design issue with no active Designer).
    pub waiting_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const COLUMNS: &str = "id, repo_id, milestone, status, step_mode, current_wave, waiting_reason, created_at, updated_at";

impl MilestoneRun {
    pub async fn list_by_repo(pool: &SqlitePool, repo_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, MilestoneRun>(&format!(
            "SELECT {COLUMNS} FROM milestone_runs WHERE repo_id = ?1 ORDER BY created_at ASC"
        ))
        .bind(repo_id)
        .fetch_all(pool)
        .await
    }

    /// Runs the engine has to look at on each sweep.
    pub async fn list_active(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, MilestoneRun>(&format!(
            "SELECT {COLUMNS} FROM milestone_runs WHERE status IN ('running', 'waiting')"
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn find(
        pool: &SqlitePool,
        repo_id: Uuid,
        milestone: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, MilestoneRun>(&format!(
            "SELECT {COLUMNS} FROM milestone_runs WHERE repo_id = ?1 AND milestone = ?2"
        ))
        .bind(repo_id)
        .bind(milestone)
        .fetch_optional(pool)
        .await
    }

    /// Start (or resume) the run of a milestone. A finished run starts over.
    pub async fn play(
        pool: &SqlitePool,
        repo_id: Uuid,
        milestone: &str,
        step_mode: bool,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "INSERT INTO milestone_runs (id, repo_id, milestone, status, step_mode)
                  VALUES (?1, ?2, ?3, 'running', ?4)
             ON CONFLICT (repo_id, milestone) DO UPDATE
                SET status = 'running', step_mode = excluded.step_mode,
                    waiting_reason = NULL, updated_at = datetime('now', 'subsec')",
        )
        .bind(Uuid::new_v4())
        .bind(repo_id)
        .bind(milestone)
        .bind(step_mode)
        .execute(pool)
        .await?;
        Self::find(pool, repo_id, milestone)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn set_state(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
        current_wave: Option<i64>,
        waiting_reason: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE milestone_runs
                SET status = ?2, current_wave = ?3, waiting_reason = ?4,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(status)
        .bind(current_wave)
        .bind(waiting_reason)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Pause keeps whatever is already running; nothing new is dispatched.
    pub async fn pause(
        pool: &SqlitePool,
        repo_id: Uuid,
        milestone: &str,
    ) -> Result<u64, sqlx::Error> {
        let r = sqlx::query(
            "UPDATE milestone_runs SET status = 'paused', updated_at = datetime('now', 'subsec')
              WHERE repo_id = ?1 AND milestone = ?2 AND status IN ('running', 'waiting')",
        )
        .bind(repo_id)
        .bind(milestone)
        .execute(pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// Reset: forget the run. Already merged work is untouched.
    pub async fn delete(
        pool: &SqlitePool,
        repo_id: Uuid,
        milestone: &str,
    ) -> Result<u64, sqlx::Error> {
        let r = sqlx::query("DELETE FROM milestone_runs WHERE repo_id = ?1 AND milestone = ?2")
            .bind(repo_id)
            .bind(milestone)
            .execute(pool)
            .await?;
        Ok(r.rows_affected())
    }

    pub async fn set_step_mode(
        pool: &SqlitePool,
        repo_id: Uuid,
        step_mode: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE milestone_runs SET step_mode = ?2, updated_at = datetime('now', 'subsec')
              WHERE repo_id = ?1",
        )
        .bind(repo_id)
        .bind(step_mode)
        .execute(pool)
        .await?;
        Ok(())
    }
}
