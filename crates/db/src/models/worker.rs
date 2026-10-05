use chrono::{DateTime, Utc};
use executors::executors::BaseCodingAgent;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

pub const ROLE_DEVELOPER: &str = "developer";
pub const ROLE_ANALYST: &str = "analyst";
pub const ROLE_REVIEWER: &str = "reviewer";
pub const ROLE_DESIGNER: &str = "designer";
/// QA profile (fluke v2, #687): writes tests first and validates PRs.
pub const ROLE_QA: &str = "qa";
/// Specialist profiles. DevOps implements like a developer (opens the PR);
/// the Analyst picks it per issue in the plan block. The Architect writes an
/// ADR before development; Docs, Quality and Security are gates before the
/// review.
pub const ROLE_DEVOPS: &str = "devops";
pub const ROLE_ARCHITECT: &str = "architect";
pub const ROLE_DOCS: &str = "docs";
pub const ROLE_QUALITY: &str = "quality";
pub const ROLE_SECURITY: &str = "security";

/// Roles that implement an issue end to end and open its PR.
pub fn is_implementer(role: &str) -> bool {
    role == ROLE_DEVELOPER || role == ROLE_DEVOPS
}

/// Where a profile joins the flow of an issue: before development (commits
/// on a branch the next phase starts from), as the implementer, or as a gate
/// on the PR before the review.
pub const STAGE_PRE_DEV: &str = "pre_dev";
pub const STAGE_IMPLEMENT: &str = "implement";
pub const STAGE_GATE: &str = "gate";

/// Whether a profile of `role` can join `stage`. Phases before development
/// and gates run through the non-developer path (no PR of their own); the
/// implementer is the one that opens it.
pub fn can_join_stage(role: &str, stage: &str) -> bool {
    match stage {
        STAGE_IMPLEMENT => is_implementer(role),
        STAGE_PRE_DEV | STAGE_GATE => matches!(
            role,
            ROLE_QA | ROLE_ARCHITECT | ROLE_DOCS | ROLE_QUALITY | ROLE_SECURITY
        ),
        _ => false,
    }
}

/// A profile's place in the flow of an issue. `stage: None` = the profile
/// is not in the flow (Fluke and loose tasks can still use it).
#[derive(Debug, Clone, Default, PartialEq, Eq, FromRow, Serialize, Deserialize, TS)]
pub struct ProfileFlow {
    /// How `fluke:plan` names the profile. Set the first time the profile
    /// joins the flow and never changed, so plans already written keep
    /// pointing at it.
    pub slug: Option<String>,
    pub stage: Option<String>,
    /// Runs on every issue with a plan, without the plan asking for it.
    pub always: bool,
    /// Position inside its stage, ascending.
    #[ts(type = "number")]
    pub order: i64,
    /// When Fluke offers the profile in a brief.
    pub offer_when: Option<String>,
}

/// `name` as a slug: lowercase ASCII letters and digits joined by `-`.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "perfil".to_string()
    } else {
        out
    }
}
/// El Director (en la UI, "Fluke"): uno solo por instalación, lo crea fluke
/// y nunca toma tareas de la cola.
pub const ROLE_ORCHESTRATOR: &str = "orchestrator";

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Worker {
    pub id: Uuid,
    pub name: String,
    pub emoji: String,
    pub soul: String,
    pub role: String,
    /// Coding agent this worker runs on. `None` = follow the global default
    /// agent. `model` always belongs to this agent's catalog.
    pub executor: Option<BaseCodingAgent>,
    pub model: Option<String>,
    /// Personal Access Token for GitHub. Write-only: never returned by the
    /// API. When set, push/PR/review operations performed on behalf of this
    /// worker use this token (via `GH_TOKEN` / git http headers) instead of
    /// the machine's global gh auth.
    ///
    /// Defensive `skip_serializing`: this struct derives `Serialize` for
    /// internal use, but if a future caller accidentally hands a `Worker`
    /// to axum/tokio-json, the token must not leak. The public shape is
    /// `WorkerResponse { has_github_pat: bool }` — that is the only value
    /// the API is allowed to expose.
    #[serde(default, skip_serializing)]
    pub github_pat: Option<String>,
    /// GitHub login the PAT belongs to. Captured server-side when the PAT is
    /// validated against `/user` — never user-supplied. Cleared together with
    /// the PAT. Used by the review-dispatch identity guard (a reviewer whose
    /// login equals the PR author cannot submit an actionable review).
    pub github_login: Option<String>,
    /// Per-worker override for plan mode. `None` = follow the global
    /// `executor_profile.permission_policy`; `Some(true)` = force plan mode
    /// on; `Some(false)` = force plan mode off for this worker.
    pub plan_mode: Option<bool>,
    /// Soft-delete flag. `false` = active; `true` = archived (hidden from the
    /// main listing and skipped by orchestrator lookups, but the record and
    /// its history are preserved so an operator can restore or purge it).
    #[serde(default)]
    pub archived: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateWorker {
    pub name: String,
    pub emoji: String,
    pub soul: String,
    pub role: Option<String>,
    pub executor: Option<BaseCodingAgent>,
    pub model: Option<String>,
    pub github_pat: Option<String>,
    /// Login resolved from PAT validation; must be `Some` whenever
    /// `github_pat` is `Some` (the route layer enforces this).
    pub github_login: Option<String>,
    pub plan_mode: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateWorker {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub soul: Option<String>,
    pub role: Option<String>,
    /// `None` = don't change; `Some(None)` = follow the global default agent.
    pub executor: Option<Option<BaseCodingAgent>>,
    /// `None` = don't change; `Some(None)` = clear to global default; `Some(Some(x))` = set override
    pub model: Option<Option<String>>,
    /// `None` = don't touch; `Some(None)` = clear the PAT; `Some(Some(x))` = set new PAT.
    pub github_pat: Option<Option<String>>,
    /// Follows `github_pat`: set alongside a new PAT, cleared alongside a
    /// cleared PAT. The route layer keeps the two in lockstep.
    pub github_login: Option<Option<String>>,
    /// `None` = don't touch; `Some(None)` = clear the override (follow global);
    /// `Some(Some(bool))` = force plan mode on/off for this worker.
    pub plan_mode: Option<Option<bool>>,
}

impl Worker {
    /// Active workers (archived = 0). Used by every caller that treats
    /// archived workers as gone: the main UI listing, `start-all`, the
    /// reviewer picker, the auto-ingest reconciler, etc. Callers that need
    /// to reach an archived worker (restore, purge, admin views) must go
    /// through `find_by_id` or `list_archived`.
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode, archived, created_at
               FROM workers
               WHERE archived = 0
               ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await
    }

    /// Only archived workers, newest-archive first is not tracked separately
    /// (no `archived_at` column), so we fall back to creation order. Used by
    /// the "Workers archivados" section on the workers page.
    pub async fn list_archived(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode, archived, created_at
               FROM workers
               WHERE archived = 1
               ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode, archived, created_at
               FROM workers
               WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    /// The Director worker, archived or not (there is at most one).
    pub async fn find_orchestrator(pool: &SqlitePool) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode, archived, created_at
               FROM workers
               WHERE role = ?1",
        )
        .bind(ROLE_ORCHESTRATOR)
        .fetch_optional(pool)
        .await
    }

    /// Flip the archived flag. Idempotent: re-archiving an already-archived
    /// worker (or unarchiving an active one) is a no-op at the row level and
    /// returns Ok without erroring.
    pub async fn set_archived(
        pool: &SqlitePool,
        id: Uuid,
        archived: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE workers SET archived = ?2 WHERE id = ?1")
            .bind(id)
            .bind(archived)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn create(pool: &SqlitePool, data: &CreateWorker) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let role = data.role.as_deref().unwrap_or(ROLE_DEVELOPER).to_string();
        sqlx::query(
            "INSERT INTO workers (id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(id)
        .bind(&data.name)
        .bind(&data.emoji)
        .bind(&data.soul)
        .bind(&role)
        .bind(data.executor)
        .bind(&data.model)
        .bind(&data.github_pat)
        .bind(&data.github_login)
        .bind(data.plan_mode)
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
        // None = keep existing; Some(None) = clear; Some(Some(x)) = set to x
        let executor = data.executor.unwrap_or(existing.executor);
        let model = data.model.clone().unwrap_or(existing.model.clone());
        let github_pat = data
            .github_pat
            .clone()
            .unwrap_or(existing.github_pat.clone());
        let github_login = data
            .github_login
            .clone()
            .unwrap_or(existing.github_login.clone());
        let plan_mode = data.plan_mode.unwrap_or(existing.plan_mode);

        sqlx::query(
            "UPDATE workers
                SET name         = ?2,
                    emoji        = ?3,
                    soul         = ?4,
                    role         = ?5,
                    model        = ?6,
                    github_pat   = ?7,
                    github_login = ?8,
                    plan_mode    = ?9,
                    executor     = ?10
              WHERE id = ?1",
        )
        .bind(id)
        .bind(name)
        .bind(emoji)
        .bind(soul)
        .bind(role)
        .bind(model)
        .bind(github_pat)
        .bind(github_login)
        .bind(plan_mode)
        .bind(executor)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Pin `default_executor` on workers that chose a model before workers
    /// could choose their agent (issue #614): that model belonged to the
    /// default agent of the time. Idempotent; returns the rows touched.
    pub async fn backfill_executor(
        pool: &SqlitePool,
        default_executor: BaseCodingAgent,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE workers SET executor = ?1 WHERE executor IS NULL AND model IS NOT NULL",
        )
        .bind(default_executor)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        // workspaces.worker_id references workers(id) without ON DELETE, so any
        // workspace ever attached to the worker (including archived history)
        // must be detached first or the delete fails with a FK violation.
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE workspaces SET worker_id = NULL WHERE worker_id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM workers WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result.rows_affected())
    }

    /// Bulk-purge every archived worker in a single transaction. Detaches any
    /// workspace still pointing to one of the archived workers before running
    /// the delete so the FK constraint on `workspaces.worker_id` cannot fire.
    /// Returns the number of worker rows removed (0 when there is nothing to
    /// purge — no error).
    pub async fn delete_all_archived(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "UPDATE workspaces SET worker_id = NULL
               WHERE worker_id IN (SELECT id FROM workers WHERE archived = 1)",
        )
        .execute(&mut *tx)
        .await?;
        let result = sqlx::query("DELETE FROM workers WHERE archived = 1")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
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
                 AND status IN ('in_progress', 'waiting_user', 'in_review')",
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

    /// Name the worker had before becoming a profile (fluke v2, #681), shown
    /// as "Migrado de" on the Perfiles screen. Read on its own so the many
    /// `SELECT`s that build `Worker` stay as they are.
    pub async fn migrated_from(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>("SELECT migrated_from FROM workers WHERE id = ?1")
            .bind(worker_id)
            .fetch_optional(pool)
            .await
            .map(Option::flatten)
    }

    /// The profile's place in the flow. Read on its own, like
    /// `migrated_from`, so the `SELECT`s that build `Worker` stay as they are.
    pub async fn flow(pool: &SqlitePool, worker_id: Uuid) -> Result<ProfileFlow, sqlx::Error> {
        Ok(sqlx::query_as::<_, ProfileFlow>(
            "SELECT flow_slug AS slug, flow_stage AS stage, flow_always AS always,
                    flow_order AS \"order\", flow_offer_when AS offer_when
               FROM workers WHERE id = ?1",
        )
        .bind(worker_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or_default())
    }

    /// Put the profile in `stage` (`None` takes it out of the flow). The
    /// slug is derived from the name the first time and kept afterwards; a
    /// profile that changes stage goes last in the new one.
    pub async fn set_flow(
        pool: &SqlitePool,
        worker_id: Uuid,
        stage: Option<&str>,
        always: bool,
        offer_when: Option<&str>,
    ) -> Result<ProfileFlow, sqlx::Error> {
        let worker = Self::find_by_id(pool, worker_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        let current = Self::flow(pool, worker_id).await?;
        let slug = match (&current.slug, stage) {
            (Some(slug), _) => Some(slug.clone()),
            (None, Some(_)) => Some(Self::free_slug(pool, &slugify(&worker.name)).await?),
            (None, None) => None,
        };
        let order = if stage.is_some() && current.stage.as_deref() != stage {
            sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(flow_order), 0) + 10 FROM workers WHERE flow_stage = ?1",
            )
            .bind(stage)
            .fetch_one(pool)
            .await?
        } else {
            current.order
        };
        sqlx::query(
            "UPDATE workers
                SET flow_slug = ?2, flow_stage = ?3, flow_always = ?4,
                    flow_order = ?5, flow_offer_when = ?6
              WHERE id = ?1",
        )
        .bind(worker_id)
        .bind(&slug)
        .bind(stage)
        .bind(always)
        .bind(order)
        .bind(offer_when.map(str::trim).filter(|s| !s.is_empty()))
        .execute(pool)
        .await?;
        Self::flow(pool, worker_id).await
    }

    /// `base`, or `base-2`, `base-3`… whichever no profile uses yet.
    async fn free_slug(pool: &SqlitePool, base: &str) -> Result<String, sqlx::Error> {
        let taken: Vec<String> =
            sqlx::query_scalar("SELECT flow_slug FROM workers WHERE flow_slug IS NOT NULL")
                .fetch_all(pool)
                .await?;
        let mut slug = base.to_string();
        let mut n = 2;
        while taken.contains(&slug) {
            slug = format!("{base}-{n}");
            n += 1;
        }
        Ok(slug)
    }

    /// Active profiles in the flow, by stage and then by their order there.
    pub async fn list_flow(pool: &SqlitePool) -> Result<Vec<(Self, ProfileFlow)>, sqlx::Error> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM workers
              WHERE archived = 0 AND flow_stage IS NOT NULL
              ORDER BY flow_stage, flow_order, created_at",
        )
        .fetch_all(pool)
        .await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(worker) = Self::find_by_id(pool, id).await? {
                let flow = Self::flow(pool, id).await?;
                out.push((worker, flow));
            }
        }
        Ok(out)
    }

    /// Order the profiles of a stage as `worker_ids` lists them.
    pub async fn set_flow_order(pool: &SqlitePool, worker_ids: &[Uuid]) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        for (i, id) in worker_ids.iter().enumerate() {
            sqlx::query("UPDATE workers SET flow_order = ?2 WHERE id = ?1")
                .bind(id)
                .bind((i as i64 + 1) * 10)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
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

    /// All non-archived workspaces currently attached to the worker. A
    /// worker is a profile (#680) and each running instance has its own;
    /// the orchestrator also uses this to auto-repair orphan workspaces.
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

    /// First active worker with the `reviewer` role (by creation order), if
    /// any. Archived reviewers are skipped so an archived identity never
    /// receives a fresh review dispatch.
    ///
    /// Prefer [`list_active_reviewers_lru`] for dispatch selection — this
    /// helper picks the same reviewer every time and therefore does not
    /// balance load across multiple reviewers.
    pub async fn find_first_reviewer(pool: &SqlitePool) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT id, name, emoji, soul, role, executor, model, github_pat, github_login, plan_mode, archived, created_at
               FROM workers
               WHERE role = 'reviewer' AND archived = 0
               ORDER BY created_at ASC
               LIMIT 1",
        )
        .fetch_optional(pool)
        .await
    }

    /// Active reviewers ordered "least-recently-assigned first" so callers can
    /// balance load across multiple reviewer identities.
    ///
    /// Ranking rules:
    /// 1. Reviewers that have never been given a `worker_task` come first
    ///    (SQLite ranks `NULL` ahead of any timestamp under `ORDER BY ASC`).
    /// 2. Then reviewers whose most-recent `worker_task.created_at` is
    ///    oldest — i.e. the one who has been idle the longest.
    /// 3. Ties (same last-assignment timestamp, or all-null within a group)
    ///    break on `workers.created_at` to keep the order deterministic.
    ///
    /// Archived reviewers are excluded so an archived identity never receives
    /// a fresh review dispatch.
    ///
    /// Callers iterate this list and pick the first reviewer that satisfies
    /// their own filters (self-review guard, per-reviewer capacity, etc.).
    /// With a single active reviewer the returned list has length 1 — the
    /// same reviewer that the legacy `find_first_reviewer` would have picked.
    pub async fn list_active_reviewers_lru(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Worker>(
            "SELECT w.id, w.name, w.emoji, w.soul, w.role, w.executor, w.model, w.github_pat,
                    w.github_login, w.plan_mode, w.archived, w.created_at
               FROM workers w
               LEFT JOIN (
                   SELECT worker_id, MAX(created_at) AS last_task_at
                     FROM worker_tasks
                    GROUP BY worker_id
               ) t ON t.worker_id = w.id
              WHERE w.role = 'reviewer'
                AND w.archived = 0
              ORDER BY t.last_task_at ASC,
                       w.created_at ASC",
        )
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

    /// Convenience: load the worker's PAT (if any) by workspace. Returns
    /// `None` when the workspace has no worker attached or the worker has
    /// no PAT set. Kept as a scalar query so we never load the token unless
    /// the caller specifically asks for it.
    pub async fn find_github_pat_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT w.github_pat
               FROM workspaces ws
               JOIN workers w ON w.id = ws.worker_id
               WHERE ws.id = ?1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
        .map(|opt| opt.flatten())
    }

    /// Like [`find_github_pat_by_workspace_id`] but also returns the worker's
    /// role, so callers that only want to inject the token for some roles
    /// don't need a second lookup.
    pub async fn find_github_pat_and_role_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<(Option<String>, String)>, sqlx::Error> {
        sqlx::query_as::<_, (Option<String>, String)>(
            "SELECT w.github_pat, w.role
               FROM workspaces ws
               JOIN workers w ON w.id = ws.worker_id
               WHERE ws.id = ?1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_stages() {
        assert_eq!(slugify("Performance"), "performance");
        assert_eq!(
            slugify("  Revisión de Seguridad! "),
            "revision-de-seguridad"
        );
        assert_eq!(slugify("Data model v2"), "data-model-v2");
        assert_eq!(slugify("🤖"), "perfil");
        assert!(can_join_stage(ROLE_QUALITY, STAGE_GATE));
        assert!(can_join_stage(ROLE_DEVOPS, STAGE_IMPLEMENT));
        assert!(!can_join_stage(ROLE_DEVELOPER, STAGE_GATE));
        assert!(!can_join_stage(ROLE_SECURITY, STAGE_IMPLEMENT));
        assert!(!can_join_stage(ROLE_REVIEWER, STAGE_PRE_DEV));
    }
}
