//! Misiones del Director (tablas `missions`, `mission_items`,
//! `mission_briefs`, `mission_issues`). Ver la migración
//! `20261001120000_add_director.sql`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

pub const STATUS_DRAFT: &str = "draft";
pub const STATUS_CLARIFYING: &str = "clarifying";
pub const STATUS_BRIEF_READY: &str = "brief_ready";
pub const STATUS_PLANNING: &str = "planning";
pub const STATUS_CLOSED: &str = "closed";

pub const AUTONOMY_VALUES: [&str; 3] = ["step", "brief_pr", "autopilot"];

/// Pregunta abierta del agente al user, con respuestas rápidas (chips).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PendingQuestion {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Mission {
    pub id: Uuid,
    pub title: String,
    pub status: String,
    pub autonomy: String,
    pub repo_id: Option<Uuid>,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub pending_questions: Vec<PendingQuestion>,
    pub ui_context: Option<String>,
    pub analyst_task_id: Option<Uuid>,
    pub cost_cap_usd: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(FromRow)]
struct MissionRow {
    id: Uuid,
    title: String,
    status: String,
    autonomy: String,
    repo_id: Option<Uuid>,
    session_id: Uuid,
    workspace_id: Uuid,
    pending_questions: String,
    ui_context: Option<String>,
    analyst_task_id: Option<Uuid>,
    cost_cap_usd: Option<f64>,
    created_at: String,
    updated_at: String,
}

impl From<MissionRow> for Mission {
    fn from(r: MissionRow) -> Self {
        Self {
            id: r.id,
            title: r.title,
            status: r.status,
            autonomy: r.autonomy,
            repo_id: r.repo_id,
            session_id: r.session_id,
            workspace_id: r.workspace_id,
            pending_questions: serde_json::from_str(&r.pending_questions).unwrap_or_default(),
            ui_context: r.ui_context,
            analyst_task_id: r.analyst_task_id,
            cost_cap_usd: r.cost_cap_usd,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MissionItem {
    pub id: Uuid,
    pub mission_id: Uuid,
    #[ts(type = "number")]
    pub position: i64,
    pub kind: String,
    pub title: String,
    pub fields: BTreeMap<String, String>,
    pub worker_id: Option<Uuid>,
    pub model: Option<String>,
    pub route_reason: Option<String>,
}

#[derive(FromRow)]
struct ItemRow {
    id: Uuid,
    mission_id: Uuid,
    position: i64,
    kind: String,
    title: String,
    fields: String,
    worker_id: Option<Uuid>,
    model: Option<String>,
    route_reason: Option<String>,
}

impl From<ItemRow> for MissionItem {
    fn from(r: ItemRow) -> Self {
        Self {
            id: r.id,
            mission_id: r.mission_id,
            position: r.position,
            kind: r.kind,
            title: r.title,
            fields: serde_json::from_str(&r.fields).unwrap_or_default(),
            worker_id: r.worker_id,
            model: r.model,
            route_reason: r.route_reason,
        }
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct MissionBrief {
    pub mission_id: Uuid,
    #[ts(type = "number")]
    pub version: i64,
    pub markdown: String,
    pub created_at: String,
}

const MISSION_SELECT: &str = "SELECT m.id, m.title, m.status, m.autonomy, m.repo_id, m.session_id,
        s.workspace_id, m.pending_questions, m.ui_context, m.analyst_task_id,
        m.cost_cap_usd, m.created_at, m.updated_at
   FROM missions m JOIN sessions s ON s.id = m.session_id";

const ITEM_SELECT: &str = "SELECT id, mission_id, position, kind, title, fields, worker_id, model,
        route_reason
   FROM mission_items";

impl Mission {
    pub async fn create(
        pool: &SqlitePool,
        session_id: Uuid,
        repo_id: Option<Uuid>,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO missions (id, session_id, repo_id) VALUES (?1, ?2, ?3)")
            .bind(id)
            .bind(session_id)
            .bind(repo_id)
            .execute(pool)
            .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query_as::<_, MissionRow>(&format!("{MISSION_SELECT} WHERE m.id = ?1"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(Into::into))
    }

    pub async fn find_by_session_id(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row =
            sqlx::query_as::<_, MissionRow>(&format!("{MISSION_SELECT} WHERE m.session_id = ?1"))
                .bind(session_id)
                .fetch_optional(pool)
                .await?;
        Ok(row.map(Into::into))
    }

    /// Todas las misiones de la instalación (el Director es global): la
    /// guardia de Fluke primero, después las abiertas y luego por actividad.
    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        let rows = sqlx::query_as::<_, MissionRow>(&format!(
            "{MISSION_SELECT} \
             ORDER BY m.id IS (SELECT mission_id FROM fluke_guard WHERE id = 1) DESC, \
                      (m.status = 'closed'), m.updated_at DESC"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn set_status(pool: &SqlitePool, id: Uuid, status: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE missions SET status = ?2, updated_at = datetime('now', 'subsec') WHERE id = ?1",
        )
        .bind(id)
        .bind(status)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_title(pool: &SqlitePool, id: Uuid, title: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE missions SET title = ?2, updated_at = datetime('now', 'subsec') WHERE id = ?1",
        )
        .bind(id)
        .bind(title)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_repo(
        pool: &SqlitePool,
        id: Uuid,
        repo_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE missions SET repo_id = ?2, updated_at = datetime('now', 'subsec') WHERE id = ?1",
        )
        .bind(id)
        .bind(repo_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_autonomy(
        pool: &SqlitePool,
        id: Uuid,
        autonomy: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE missions SET autonomy = ?2, updated_at = datetime('now', 'subsec') WHERE id = ?1",
        )
        .bind(id)
        .bind(autonomy)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_pending_questions(
        pool: &SqlitePool,
        id: Uuid,
        questions: &[PendingQuestion],
    ) -> Result<(), sqlx::Error> {
        let json = serde_json::to_string(questions).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "UPDATE missions SET pending_questions = ?2, updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(json)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_ui_context(
        pool: &SqlitePool,
        id: Uuid,
        ui_context: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE missions SET ui_context = ?2 WHERE id = ?1")
            .bind(id)
            .bind(ui_context)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_analyst_task(
        pool: &SqlitePool,
        id: Uuid,
        task_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE missions SET analyst_task_id = ?2, updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(task_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    // ----- ítems del brief -------------------------------------------------

    pub async fn items(pool: &SqlitePool, id: Uuid) -> Result<Vec<MissionItem>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ItemRow>(&format!(
            "{ITEM_SELECT} WHERE mission_id = ?1 ORDER BY position"
        ))
        .bind(id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Crea un ítem (sin `item_id`) o actualiza uno existente. Los campos se
    /// mezclan con los que ya tenía; un valor vacío borra el campo.
    pub async fn upsert_item(
        pool: &SqlitePool,
        id: Uuid,
        item_id: Option<Uuid>,
        kind: &str,
        title: Option<&str>,
        fields: &BTreeMap<String, String>,
    ) -> Result<MissionItem, sqlx::Error> {
        let existing = match item_id {
            Some(item_id) => sqlx::query_as::<_, ItemRow>(&format!(
                "{ITEM_SELECT} WHERE id = ?1 AND mission_id = ?2"
            ))
            .bind(item_id)
            .bind(id)
            .fetch_optional(pool)
            .await?
            .map(MissionItem::from),
            None => None,
        };
        let mut merged = existing
            .as_ref()
            .map(|i| i.fields.clone())
            .unwrap_or_default();
        for (k, v) in fields {
            if v.trim().is_empty() {
                merged.remove(k);
            } else {
                merged.insert(k.clone(), v.trim().to_string());
            }
        }
        let fields_json = serde_json::to_string(&merged).unwrap_or_else(|_| "{}".into());

        let item_id = match existing {
            Some(item) => {
                sqlx::query(
                    "UPDATE mission_items
                        SET kind = ?2, title = COALESCE(?3, title), fields = ?4,
                            updated_at = datetime('now', 'subsec')
                      WHERE id = ?1",
                )
                .bind(item.id)
                .bind(kind)
                .bind(title)
                .bind(&fields_json)
                .execute(pool)
                .await?;
                item.id
            }
            None => {
                let new_id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO mission_items (id, mission_id, position, kind, title, fields)
                     VALUES (?1, ?2,
                             (SELECT COALESCE(MAX(position), 0) + 1 FROM mission_items
                               WHERE mission_id = ?2),
                             ?3, COALESCE(?4, ''), ?5)",
                )
                .bind(new_id)
                .bind(id)
                .bind(kind)
                .bind(title)
                .bind(&fields_json)
                .execute(pool)
                .await?;
                new_id
            }
        };
        sqlx::query("UPDATE missions SET updated_at = datetime('now', 'subsec') WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        let row = sqlx::query_as::<_, ItemRow>(&format!("{ITEM_SELECT} WHERE id = ?1"))
            .bind(item_id)
            .fetch_one(pool)
            .await?;
        Ok(row.into())
    }

    /// Devuelve `false` si el ítem no era de esta misión.
    pub async fn remove_item(
        pool: &SqlitePool,
        id: Uuid,
        item_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let res = sqlx::query("DELETE FROM mission_items WHERE id = ?1 AND mission_id = ?2")
            .bind(item_id)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Borra la misión. Items, versiones del brief y links a issues caen por
    /// cascada; los issues en GitHub (y su espejo `repo_issues`) no se tocan.
    /// La sesión queda: es del workspace scratch, no de la misión.
    /// Devuelve `false` si la misión no existía.
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE fluke_guard SET focus_mission_id = NULL WHERE focus_mission_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM fluke_turn_focus WHERE mission_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let res = sqlx::query("DELETE FROM missions WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(res.rows_affected() > 0)
    }

    // ----- versiones del brief ---------------------------------------------

    pub async fn add_brief_version(
        pool: &SqlitePool,
        id: Uuid,
        markdown: &str,
    ) -> Result<i64, sqlx::Error> {
        let version: i64 = sqlx::query_scalar(
            "INSERT INTO mission_briefs (mission_id, version, markdown)
             VALUES (?1, (SELECT COALESCE(MAX(version), 0) + 1 FROM mission_briefs
                           WHERE mission_id = ?1), ?2)
             RETURNING version",
        )
        .bind(id)
        .bind(markdown)
        .fetch_one(pool)
        .await?;
        Ok(version)
    }

    pub async fn briefs(pool: &SqlitePool, id: Uuid) -> Result<Vec<MissionBrief>, sqlx::Error> {
        sqlx::query_as::<_, MissionBrief>(
            "SELECT mission_id, version, markdown, created_at FROM mission_briefs
              WHERE mission_id = ?1 ORDER BY version DESC",
        )
        .bind(id)
        .fetch_all(pool)
        .await
    }

    // ----- issues de la misión ---------------------------------------------

    /// Registra un issue creado por la request al Analista de alguna misión.
    /// No hace nada si la tarea no es la request de una misión.
    pub async fn link_issue_for_task(
        pool: &SqlitePool,
        task_id: Uuid,
        repo_id: Uuid,
        issue_number: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT OR IGNORE INTO mission_issues (mission_id, repo_id, issue_number)
             SELECT id, ?2, ?3 FROM missions WHERE analyst_task_id = ?1",
        )
        .bind(task_id)
        .bind(repo_id)
        .bind(issue_number)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// (issues de la misión, cuántos ya están cerrados en el espejo local).
    pub async fn issue_progress(pool: &SqlitePool, id: Uuid) -> Result<(i64, i64), sqlx::Error> {
        sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(UPPER(ri.state) = 'CLOSED'), 0)
               FROM mission_issues mi
               LEFT JOIN repo_issues ri
                 ON ri.repo_id = mi.repo_id AND ri.number = mi.issue_number
              WHERE mi.mission_id = ?1",
        )
        .bind(id)
        .fetch_one(pool)
        .await
    }

    /// Si el agente de la misión está respondiendo ahora.
    pub async fn agent_running(pool: &SqlitePool, id: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM execution_processes ep
                              JOIN missions m ON m.session_id = ep.session_id
                             WHERE m.id = ?1 AND ep.status IN ('running', 'queued'))",
        )
        .bind(id)
        .fetch_one(pool)
        .await
    }

    pub async fn issue_numbers(pool: &SqlitePool, id: Uuid) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT issue_number FROM mission_issues WHERE mission_id = ?1 ORDER BY issue_number",
        )
        .bind(id)
        .fetch_all(pool)
        .await
    }
}
