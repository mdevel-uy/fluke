//! Bus de eventos de dominio (J0.2, #728).
//!
//! Las filas las escriben triggers de SQLite (migración
//! `20261004000000_add_fluke_events.sql`) cada vez que cambia un estado:
//! tareas, review, PRs y CI, misiones, ejecución por milestone, planes y
//! perfiles. Así ningún camino de código se escapa. Acá solo se leen. El
//! estado actual sale de las tablas; esto son los deltas, para que Fluke se
//! entere de lo que pasó y decida si avisar. Queries runtime-checked
//! (`sqlx::query_as`) para no tocar el cache offline de sqlx.

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// Solo para la UI: nunca se le manda a Fluke.
pub const SEVERITY_PROGRESS: &str = "progress";

#[derive(Debug, Clone, FromRow, Serialize, TS)]
pub struct FlukeEvent {
    #[ts(type = "number")]
    pub id: i64,
    pub created_at: String,
    /// `task.failed`, `review.approve`, `pr.ci_failing`, `mission.brief_ready`…
    pub kind: String,
    /// `progress` | `info` | `ask` | `alert`
    pub severity: String,
    pub subject_id: Option<Uuid>,
    pub repo_id: Option<Uuid>,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    #[ts(type = "number | null")]
    pub pr_number: Option<i64>,
    pub title: Option<String>,
    pub detail: Option<String>,
}

impl FlukeEvent {
    /// Eventos posteriores a `after_id`, del más viejo al más nuevo.
    pub async fn list_after(
        pool: &SqlitePool,
        after_id: i64,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT id, created_at, kind, severity, subject_id, repo_id, issue_number, \
                    pr_number, title, detail \
               FROM fluke_events WHERE id > ? ORDER BY id ASC LIMIT ?",
        )
        .bind(after_id)
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// Los `limit` más recientes, del más viejo al más nuevo.
    pub async fn latest(pool: &SqlitePool, limit: i64) -> Result<Vec<Self>, sqlx::Error> {
        let mut rows = sqlx::query_as::<_, Self>(
            "SELECT id, created_at, kind, severity, subject_id, repo_id, issue_number, \
                    pr_number, title, detail \
               FROM fluke_events ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(pool)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// Id del último evento (0 si no hay): punto de partida de un suscriptor
    /// que no quiere recibir el pasado.
    pub async fn last_id(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM fluke_events")
            .fetch_one(pool)
            .await
    }
}

/// La conversación de guardia de Fluke (J0.3): una misión fija donde entran
/// los eventos. Una sola fila en `fluke_guard`.
#[derive(Debug, Clone, FromRow)]
pub struct FlukeGuard {
    pub mission_id: Uuid,
    pub event_cursor: i64,
    /// Segundos desde la última entrega a Fluke; `None` si nunca hubo.
    pub secs_since_delivery: Option<i64>,
}

impl FlukeGuard {
    pub async fn get(pool: &SqlitePool) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT mission_id, event_cursor, \
                    CAST(strftime('%s', 'now') - strftime('%s', last_delivery_at) AS INTEGER) \
                        AS secs_since_delivery \
               FROM fluke_guard WHERE id = 1",
        )
        .fetch_optional(pool)
        .await
    }

    /// Fija la misión de guardia. Arranca desde el último evento: el pasado
    /// no se le manda.
    pub async fn set(pool: &SqlitePool, mission_id: Uuid) -> Result<(), sqlx::Error> {
        let cursor = FlukeEvent::last_id(pool).await?;
        sqlx::query(
            "INSERT INTO fluke_guard (id, mission_id, event_cursor) VALUES (1, ?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET mission_id = ?1, event_cursor = ?2",
        )
        .bind(mission_id)
        .bind(cursor)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Eventos procesados hasta `cursor`; `delivered` marca que Fluke recibió
    /// un lote ahora.
    pub async fn advance(
        pool: &SqlitePool,
        cursor: i64,
        delivered: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE fluke_guard SET event_cursor = MAX(event_cursor, ?1), \
                    last_delivery_at = CASE WHEN ?2 THEN datetime('now') ELSE last_delivery_at END \
              WHERE id = 1",
        )
        .bind(cursor)
        .bind(delivered)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn is_guard(pool: &SqlitePool, mission_id: Uuid) -> Result<bool, sqlx::Error> {
        Ok(Self::get(pool)
            .await?
            .is_some_and(|g| g.mission_id == mission_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recrear una tabla en una migración (el patrón de SQLite para cambiar
    /// un CHECK) borra sus triggers sin aviso: este test lo detecta.
    #[tokio::test]
    async fn triggers_survive_migrations_and_emit() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let triggers: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fluke_events_%'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        for expected in [
            "fluke_events_task_insert",
            "fluke_events_task_status",
            "fluke_events_review_round",
            "fluke_events_pr_insert",
            "fluke_events_pr_status",
            "fluke_events_pr_ci",
            "fluke_events_mission_status",
            "fluke_events_run_status",
            "fluke_events_run_wave",
            "fluke_events_plan_status",
            "fluke_events_profile_insert",
            "fluke_events_profile_archived",
        ] {
            assert!(
                triggers.iter().any(|t| t == expected),
                "trigger {expected} missing: a migration recreated its table without it"
            );
        }

        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let worker = Uuid::new_v4();
        sqlx::query("INSERT INTO workers (id, name, emoji, soul, role) VALUES (?, 'Dev', '', '', 'developer')")
            .bind(worker)
            .execute(&pool)
            .await
            .unwrap();
        let start = FlukeEvent::last_id(&pool).await.unwrap();
        let task = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, issue_number, status) \
             VALUES (?, ?, ?, 1, '#7 Algo', 'p', 7, 'queued')",
        )
        .bind(task)
        .bind(worker)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE worker_tasks SET status = 'failed', failure_kind = 'infra', failure_reason = '404' WHERE id = ?")
            .bind(task)
            .execute(&pool)
            .await
            .unwrap();
        // Same status again: no event.
        sqlx::query("UPDATE worker_tasks SET status = 'failed' WHERE id = ?")
            .bind(task)
            .execute(&pool)
            .await
            .unwrap();

        let events = FlukeEvent::list_after(&pool, start, 10).await.unwrap();
        let kinds: Vec<(&str, &str)> = events
            .iter()
            .map(|e| (e.kind.as_str(), e.severity.as_str()))
            .collect();
        assert_eq!(kinds, [("task.queued", "progress"), ("task.failed", "alert")]);
        let failed = &events[1];
        assert_eq!(failed.subject_id, Some(task));
        assert_eq!(failed.issue_number, Some(7));
        assert_eq!(failed.detail.as_deref(), Some("developer · infra: 404"));
    }
}
