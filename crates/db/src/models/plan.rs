//! Plan de trabajo estructurado de un agente (tablas `plans`, `plan_steps`,
//! `plan_step_revisions`). Ver la migración `20260927000000_add_plans.sql`.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

pub const STATUS_RUNNING: &str = "running";
pub const STATUS_PAUSED: &str = "paused";
pub const STATUS_HALTED: &str = "halted";

pub const STEP_PENDING: &str = "pending";
pub const STEP_ACTIVE: &str = "active";
pub const STEP_DONE: &str = "done";
pub const STEP_CUT: &str = "cut";

pub const REV_REQUESTED: &str = "requested";
pub const REV_PROPOSED: &str = "proposed";
pub const REV_ACCEPTED: &str = "accepted";
pub const REV_DISCARDED: &str = "discarded";
pub const REV_DELIVERED: &str = "delivered";
pub const REV_ACKED: &str = "acked";
pub const REV_FAILED: &str = "failed";

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Plan {
    pub workspace_id: Uuid,
    pub status: String,
    pub pause_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlanStep {
    pub id: Uuid,
    #[ts(type = "number")]
    pub n: i64,
    pub title: String,
    pub summary: String,
    pub files: Vec<String>,
    pub verify: Option<String>,
    #[ts(type = "Array<number>")]
    pub depends_on: Vec<i64>,
    pub state: String,
    #[ts(type = "number")]
    pub version: i64,
    pub has_checkpoint: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(FromRow)]
struct PlanStepRow {
    id: Uuid,
    n: i64,
    title: String,
    summary: String,
    files: String,
    verify: Option<String>,
    depends_on: String,
    state: String,
    version: i64,
    checkpoint: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
}

impl From<PlanStepRow> for PlanStep {
    fn from(r: PlanStepRow) -> Self {
        Self {
            id: r.id,
            n: r.n,
            title: r.title,
            summary: r.summary,
            files: serde_json::from_str(&r.files).unwrap_or_default(),
            verify: r.verify,
            depends_on: serde_json::from_str(&r.depends_on).unwrap_or_default(),
            state: r.state,
            version: r.version,
            has_checkpoint: r.checkpoint.is_some(),
            started_at: r.started_at,
            finished_at: r.finished_at,
        }
    }
}

/// Paso tal como lo declara el agente en `submit_plan`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct NewPlanStep {
    #[ts(type = "number")]
    pub n: i64,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub verify: Option<String>,
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub depends_on: Vec<i64>,
}

/// Versión propuesta de un paso por el revisor.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StepProposal {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub verify: Option<String>,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlanStepRevision {
    pub id: Uuid,
    #[ts(type = "number")]
    pub n: i64,
    #[ts(type = "number")]
    pub round: i64,
    pub request: String,
    pub proposal: Option<StepProposal>,
    pub status: String,
    pub error: Option<String>,
    #[ts(type = "number | null")]
    pub target_n: Option<i64>,
    pub created_at: String,
}

#[derive(FromRow)]
struct RevisionRow {
    id: Uuid,
    n: i64,
    round: i64,
    request: String,
    proposal: Option<String>,
    status: String,
    error: Option<String>,
    target_n: Option<i64>,
    created_at: String,
}

impl From<RevisionRow> for PlanStepRevision {
    fn from(r: RevisionRow) -> Self {
        Self {
            id: r.id,
            n: r.n,
            round: r.round,
            request: r.request,
            proposal: r.proposal.and_then(|p| serde_json::from_str(&p).ok()),
            status: r.status,
            error: r.error,
            target_n: r.target_n,
            created_at: r.created_at,
        }
    }
}

/// Todo lo que la UI necesita del plan, emitido por WS en cada cambio.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlanSnapshot {
    pub workspace_id: Uuid,
    pub status: String,
    pub pause_requested: bool,
    pub steps: Vec<PlanStep>,
    pub revisions: Vec<PlanStepRevision>,
}

const STEP_COLS: &str = "id, n, title, summary, files, verify, depends_on, state, version, \
                         checkpoint, started_at, finished_at";
const REV_COLS: &str = "id, n, round, request, proposal, status, error, target_n, created_at";

impl Plan {
    pub async fn find(pool: &SqlitePool, workspace_id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Plan>(
            "SELECT workspace_id, status, pause_requested FROM plans WHERE workspace_id = ?1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn ensure(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT OR IGNORE INTO plans (workspace_id) VALUES (?1)")
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_status(
        pool: &SqlitePool,
        workspace_id: Uuid,
        status: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plans SET status = ?2, updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1",
        )
        .bind(workspace_id)
        .bind(status)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_pause_requested(
        pool: &SqlitePool,
        workspace_id: Uuid,
        on: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plans SET pause_requested = ?2, updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1",
        )
        .bind(workspace_id)
        .bind(on)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// El agente cierra el turno ahora (pausa en un borde de paso). Devuelve
    /// true si había una pausa pedida.
    pub async fn consume_pause(pool: &SqlitePool, workspace_id: Uuid) -> Result<bool, sqlx::Error> {
        let r = sqlx::query(
            "UPDATE plans SET pause_requested = 0, status = 'paused',
                    updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND pause_requested = 1",
        )
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    pub async fn set_resume_note(
        pool: &SqlitePool,
        workspace_id: Uuid,
        note: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE plans SET resume_note = ?2 WHERE workspace_id = ?1")
            .bind(workspace_id)
            .bind(note)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn take_resume_note(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let note: Option<Option<String>> =
            sqlx::query_scalar("SELECT resume_note FROM plans WHERE workspace_id = ?1")
                .bind(workspace_id)
                .fetch_optional(pool)
                .await?;
        Self::set_resume_note(pool, workspace_id, None).await?;
        Ok(note.flatten())
    }

    /// El fin del proceso del agente no debe finalizar el worker.
    pub async fn is_on_hold(pool: &SqlitePool, workspace_id: Uuid) -> Result<bool, sqlx::Error> {
        Ok(Self::find(pool, workspace_id)
            .await?
            .is_some_and(|p| p.status != STATUS_RUNNING))
    }

    pub async fn snapshot(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<PlanSnapshot>, sqlx::Error> {
        let Some(plan) = Self::find(pool, workspace_id).await? else {
            return Ok(None);
        };
        Ok(Some(PlanSnapshot {
            workspace_id,
            status: plan.status,
            pause_requested: plan.pause_requested,
            steps: PlanStep::list(pool, workspace_id).await?,
            revisions: PlanStepRevision::list(pool, workspace_id).await?,
        }))
    }
}

impl PlanStep {
    pub async fn list(pool: &SqlitePool, workspace_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        let rows = sqlx::query_as::<_, PlanStepRow>(&format!(
            "SELECT {STEP_COLS} FROM plan_steps WHERE workspace_id = ?1 ORDER BY n ASC"
        ))
        .bind(workspace_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn find(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query_as::<_, PlanStepRow>(&format!(
            "SELECT {STEP_COLS} FROM plan_steps WHERE workspace_id = ?1 AND n = ?2"
        ))
        .bind(workspace_id)
        .bind(n)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(Into::into))
    }

    /// Checkpoint `{repo_name: sha}` guardado al iniciar el paso.
    pub async fn checkpoint(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
    ) -> Result<Option<std::collections::HashMap<String, String>>, sqlx::Error> {
        let raw: Option<Option<String>> = sqlx::query_scalar(
            "SELECT checkpoint FROM plan_steps WHERE workspace_id = ?1 AND n = ?2",
        )
        .bind(workspace_id)
        .bind(n)
        .fetch_optional(pool)
        .await?;
        Ok(raw.flatten().and_then(|s| serde_json::from_str(&s).ok()))
    }

    /// Reemplaza los pasos no terminados por los declarados. Los pasos `done`
    /// se conservan; un paso nuevo no puede reusar su `n`.
    pub async fn replace_open(
        pool: &SqlitePool,
        workspace_id: Uuid,
        steps: &[NewPlanStep],
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM plan_steps WHERE workspace_id = ?1 AND state != 'done'")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
        for s in steps {
            sqlx::query(
                "INSERT OR IGNORE INTO plan_steps
                     (id, workspace_id, n, title, summary, files, verify, depends_on)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .bind(Uuid::new_v4())
            .bind(workspace_id)
            .bind(s.n)
            .bind(&s.title)
            .bind(&s.summary)
            .bind(serde_json::to_string(&s.files).unwrap_or_else(|_| "[]".into()))
            .bind(&s.verify)
            .bind(serde_json::to_string(&s.depends_on).unwrap_or_else(|_| "[]".into()))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    pub async fn insert(
        pool: &SqlitePool,
        workspace_id: Uuid,
        s: &NewPlanStep,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO plan_steps
                 (id, workspace_id, n, title, summary, files, verify, depends_on)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(Uuid::new_v4())
        .bind(workspace_id)
        .bind(s.n)
        .bind(&s.title)
        .bind(&s.summary)
        .bind(serde_json::to_string(&s.files).unwrap_or_else(|_| "[]".into()))
        .bind(&s.verify)
        .bind(serde_json::to_string(&s.depends_on).unwrap_or_else(|_| "[]".into()))
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn next_n(pool: &SqlitePool, workspace_id: Uuid) -> Result<i64, sqlx::Error> {
        let max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(n) FROM plan_steps WHERE workspace_id = ?1")
                .bind(workspace_id)
                .fetch_one(pool)
                .await?;
        Ok(max.unwrap_or(0) + 1)
    }

    /// Marca el paso como activo. Otro paso activo que quedó abierto se da
    /// por terminado: el agente pasó al siguiente sin cerrarlo.
    pub async fn start(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
        checkpoint: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_steps SET state = 'done', finished_at = datetime('now', 'subsec'),
                    updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND state = 'active' AND n != ?2",
        )
        .bind(workspace_id)
        .bind(n)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE plan_steps SET state = 'active', started_at = datetime('now', 'subsec'),
                    finished_at = NULL,
                    checkpoint = COALESCE(?3, checkpoint),
                    updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND n = ?2",
        )
        .bind(workspace_id)
        .bind(n)
        .bind(checkpoint.map(|c| serde_json::to_string(c).unwrap_or_default()))
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_state(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
        state: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_steps SET state = ?3,
                    finished_at = CASE WHEN ?3 = 'done' THEN datetime('now', 'subsec') ELSE finished_at END,
                    updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND n = ?2",
        )
        .bind(workspace_id)
        .bind(n)
        .bind(state)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Vuelve a `pending` los pasos indicados (revertir).
    pub async fn reset(
        pool: &SqlitePool,
        workspace_id: Uuid,
        ns: &[i64],
    ) -> Result<(), sqlx::Error> {
        for n in ns {
            sqlx::query(
                "UPDATE plan_steps SET state = 'pending', started_at = NULL, finished_at = NULL,
                        updated_at = datetime('now', 'subsec')
                  WHERE workspace_id = ?1 AND n = ?2 AND state IN ('active', 'done')",
            )
            .bind(workspace_id)
            .bind(n)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Aplica una propuesta aceptada: contenido nuevo y versión + 1.
    pub async fn apply_proposal(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
        p: &StepProposal,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_steps SET title = ?3, summary = ?4, files = ?5, verify = ?6,
                    version = version + 1, updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND n = ?2",
        )
        .bind(workspace_id)
        .bind(n)
        .bind(&p.title)
        .bind(&p.summary)
        .bind(serde_json::to_string(&p.files).unwrap_or_else(|_| "[]".into()))
        .bind(&p.verify)
        .execute(pool)
        .await?;
        Ok(())
    }
}

impl PlanStepRevision {
    pub async fn list(pool: &SqlitePool, workspace_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        let rows = sqlx::query_as::<_, RevisionRow>(&format!(
            "SELECT {REV_COLS} FROM plan_step_revisions WHERE workspace_id = ?1
              ORDER BY created_at ASC"
        ))
        .bind(workspace_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn find(pool: &SqlitePool, id: Uuid) -> Result<Option<(Uuid, Self)>, sqlx::Error> {
        let ws: Option<Uuid> =
            sqlx::query_scalar("SELECT workspace_id FROM plan_step_revisions WHERE id = ?1")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        let Some(ws) = ws else { return Ok(None) };
        let row = sqlx::query_as::<_, RevisionRow>(&format!(
            "SELECT {REV_COLS} FROM plan_step_revisions WHERE id = ?1"
        ))
        .bind(id)
        .fetch_one(pool)
        .await?;
        Ok(Some((ws, row.into())))
    }

    /// Revisión abierta (pedida o propuesta) de un paso, si hay.
    pub async fn open_for_step(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query_as::<_, RevisionRow>(&format!(
            "SELECT {REV_COLS} FROM plan_step_revisions
              WHERE workspace_id = ?1 AND n = ?2 AND status IN ('requested', 'proposed')
              ORDER BY created_at DESC LIMIT 1"
        ))
        .bind(workspace_id)
        .bind(n)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(Into::into))
    }

    pub async fn create(
        pool: &SqlitePool,
        workspace_id: Uuid,
        n: i64,
        round: i64,
        request: &str,
    ) -> Result<Uuid, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO plan_step_revisions (id, workspace_id, n, round, request)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(n)
        .bind(round)
        .bind(request)
        .execute(pool)
        .await?;
        Ok(id)
    }

    pub async fn set_proposal(
        pool: &SqlitePool,
        id: Uuid,
        proposal: &StepProposal,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_step_revisions SET proposal = ?2, status = 'proposed',
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1 AND status = 'requested'",
        )
        .bind(id)
        .bind(serde_json::to_string(proposal).unwrap_or_default())
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_failed(pool: &SqlitePool, id: Uuid, error: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_step_revisions SET status = 'failed', error = ?2,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1 AND status = 'requested'",
        )
        .bind(id)
        .bind(error)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_status(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
        target_n: Option<i64>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_step_revisions SET status = ?2, target_n = COALESCE(?3, target_n),
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(status)
        .bind(target_n)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Revisiones aceptadas que todavía no le llegaron al agente y que deben
    /// entregarse en caliente: las del paso activo y los pasos de corrección.
    pub async fn take_undelivered_live(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<(Self, PlanStep)>, sqlx::Error> {
        let rows = sqlx::query_as::<_, RevisionRow>(&format!(
            "SELECT {REV_COLS} FROM plan_step_revisions r
              WHERE r.workspace_id = ?1 AND r.status = 'accepted'
                AND (r.target_n != r.n OR EXISTS (
                      SELECT 1 FROM plan_steps s
                       WHERE s.workspace_id = r.workspace_id AND s.n = r.target_n
                         AND s.state = 'active'))
              ORDER BY r.created_at ASC"
        ))
        .bind(workspace_id)
        .fetch_all(pool)
        .await?;
        let mut out = Vec::new();
        for row in rows {
            let rev: Self = row.into();
            let target = rev.target_n.unwrap_or(rev.n);
            if let Some(step) = PlanStep::find(pool, workspace_id, target).await? {
                Self::set_status(pool, rev.id, REV_DELIVERED, None).await?;
                out.push((rev, step));
            }
        }
        Ok(out)
    }

    /// El agente empezó o cerró el paso: sus revisiones aceptadas o
    /// entregadas quedan confirmadas.
    pub async fn ack_for_step(
        pool: &SqlitePool,
        workspace_id: Uuid,
        target_n: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plan_step_revisions SET status = 'acked', updated_at = datetime('now', 'subsec')
              WHERE workspace_id = ?1 AND target_n = ?2 AND status IN ('accepted', 'delivered')",
        )
        .bind(workspace_id)
        .bind(target_n)
        .execute(pool)
        .await?;
        Ok(())
    }
}
