use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_IN_PROGRESS: &str = "in_progress";
pub const STATUS_IN_REVIEW: &str = "in_review";
/// The developer's PR received an approving verdict from the reviewer. The
/// task is done with review-loop work but the PR is still open (waiting for
/// merge). Follow-up commits fixing CI on top of the approved head are still
/// possible; `on_pr_merged` handles the final transition to `done`.
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

pub fn is_valid_status(value: &str) -> bool {
    matches!(
        value,
        STATUS_QUEUED
            | STATUS_IN_PROGRESS
            | STATUS_IN_REVIEW
            | STATUS_APPROVED
            | STATUS_DONE
            | STATUS_FAILED
    )
}

/// `failure_kind` value for tasks whose coding agent never really ran —
/// the CLI died on an API error (rate limit, model not available, auth).
/// These do not consume review rounds and are retried with backoff.
pub const FAILURE_KIND_INFRA: &str = "infra";

/// `kind` value for author fix tasks dispatched by the orchestrator on a
/// changes-requested review. These jump to the front of the author's queue
/// and are exempt from the `WORKER_MAX_IN_REVIEW` capacity guard: they exist
/// to drain in_review debt, so holding them back deadlocks the worker.
pub const KIND_REVIEW_FIX: &str = "review_fix";

/// `kind` value for orchestrator-composed handoff tasks that turn a
/// designer's deliverable into an analyst's input. Carries `source_task_id`
/// pointing at the designer task.
pub const KIND_DESIGN_HANDOFF: &str = "design_handoff";

/// Task created from the kanban board or by the orchestrator itself.
pub const SOURCE_KANBAN: &str = "kanban";
/// Ad-hoc request submitted from the Analyst Desk screen.
pub const SOURCE_DESK: &str = "desk";

pub fn is_valid_source(value: &str) -> bool {
    matches!(value, SOURCE_KANBAN | SOURCE_DESK)
}

/// Encode territory globs for storage: `None` for an empty vector (issue
/// declared no territory), `Some("[...]")` for anything else. Persisting `[]`
/// separately from `NULL` is deliberate: it distinguishes "the issue had a
/// `## Territorio` section but no path-like tokens survived parsing" from
/// "no territory section at all". The lint treats both the same way, but the
/// distinction is useful when auditing rows by hand.
fn encode_territory_globs(globs: &[String]) -> Option<String> {
    if globs.is_empty() {
        None
    } else {
        Some(serde_json::to_string(globs).unwrap_or_else(|_| "[]".to_string()))
    }
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
    /// JSON-encoded array of GitHub label names the analyst should apply to
    /// every issue created as part of this task.
    pub issue_labels: String,
    /// Origin of the task: `kanban` or `desk`.
    pub source: String,
    pub created_at: DateTime<Utc>,
    /// The TL reviewer's verdict for this task's PR: 'approved' | 'changes_requested' | NULL.
    pub review_result: Option<String>,
    /// Human-readable reason recorded when the task transitioned to
    /// 'failed'. NULL for non-failed tasks (cleared on any transition away
    /// from 'failed', e.g. a re-queue).
    pub failure_reason: Option<String>,
    /// Per-task override for the estimated man-hours saved by completing
    /// this task. `NULL` means "use the installation default"; a non-null
    /// value takes precedence over the default in the value-generated
    /// aggregation.
    pub hours_saved_override: Option<f64>,
    /// The agent's final message, captured by the orchestrator when a
    /// non-developer task finishes OK. Human-readable abstract of the
    /// deliverable; NULL for developer tasks and legacy rows.
    pub result_summary: Option<String>,
    /// Remote branch (`design/<n>-<slug>`) the designer's workspace branch
    /// was pushed to before the worktree was archived. NULL when the run
    /// produced no commits or for non-designer tasks.
    pub deliverable_ref: Option<String>,
    /// On a `kind = 'design_handoff'` task: the designer task whose
    /// deliverable this task consumes. Its existence is the "already handed
    /// off" guard for the source task.
    pub source_task_id: Option<Uuid>,
    /// JSON-encoded array of file globs parsed from the `## Territorio`
    /// section of the issue body at task creation. `None` means the issue
    /// declared no territory; `Some("[]")` means one was present but no
    /// path-like tokens survived parsing. Feeds the PR territory lint and
    /// the reviewer prompt injection (issue #95). The value is advisory —
    /// never a gate.
    pub territory_globs: Option<String>,
}

/// A finished designer deliverable that no analyst has taken yet. Feeds the
/// Analyst Desk picker and the sprint-board handoff dialog.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct PendingDesignHandoff {
    pub task_id: Uuid,
    pub repo_id: Uuid,
    pub title: String,
    pub issue_number: Option<i64>,
    pub worker_name: String,
    pub worker_emoji: String,
    pub deliverable_ref: Option<String>,
    pub result_summary: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Where a designer deliverable went: the handoff task consuming it.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct HandoffInfo {
    pub task_id: Uuid,
    pub worker_id: Uuid,
    pub worker_name: String,
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct CreateWorkerTask {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub issue_number: Option<i64>,
    pub skills: Vec<String>,
    pub issue_labels: Vec<String>,
    pub source: String,
    /// File globs parsed from the issue's `## Territorio` section. Empty
    /// vector = no territory declared, persisted as SQL `NULL` so a later
    /// `NULL vs [] ` distinction is preserved for humans reading the row.
    pub territory_globs: Vec<String>,
}

impl WorkerTask {
    /// Decode `territory_globs` into a `Vec<String>`. Returns an empty vector
    /// for `NULL`, malformed JSON, or `[]`. The lint treats "no territory"
    /// and "empty territory" identically, so callers rarely need to distinguish.
    pub fn territory_globs_parsed(&self) -> Vec<String> {
        self.territory_globs
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default()
    }

    pub async fn list_by_worker(
        pool: &SqlitePool,
        worker_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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
        let issue_labels_json =
            serde_json::to_string(&data.issue_labels).unwrap_or_else(|_| "[]".to_string());
        let territory_globs_json = encode_territory_globs(&data.territory_globs);

        sqlx::query(
            "INSERT INTO worker_tasks
                 (id, worker_id, repo_id, position, title, prompt,
                  issue_number, status, skills, issue_labels, source,
                  territory_globs)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, ?11)",
        )
        .bind(id)
        .bind(worker_id)
        .bind(data.repo_id)
        .bind(next_position)
        .bind(&data.title)
        .bind(&data.prompt)
        .bind(data.issue_number)
        .bind(&skills_json)
        .bind(&issue_labels_json)
        .bind(&data.source)
        .bind(territory_globs_json.as_deref())
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Insert a review-fix task at the FRONT of the worker's queue (position
    /// strictly below every existing task) and tag it `kind = 'review_fix'`.
    /// A changes-requested PR occupies one of the worker's in_review slots,
    /// so its remediation outranks any queued feature work.
    pub async fn prepend_review_fix(
        pool: &SqlitePool,
        worker_id: Uuid,
        data: &CreateWorkerTask,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        let front_position: i64 = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MIN(position), 1) - 1
               FROM worker_tasks
               WHERE worker_id = ?1",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await?;

        let skills_json = serde_json::to_string(&data.skills).unwrap_or_else(|_| "[]".to_string());
        let issue_labels_json =
            serde_json::to_string(&data.issue_labels).unwrap_or_else(|_| "[]".to_string());
        let territory_globs_json = encode_territory_globs(&data.territory_globs);

        sqlx::query(
            "INSERT INTO worker_tasks
                 (id, worker_id, repo_id, position, title, prompt,
                  issue_number, status, skills, issue_labels, source, kind,
                  territory_globs)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(id)
        .bind(worker_id)
        .bind(data.repo_id)
        .bind(front_position)
        .bind(&data.title)
        .bind(&data.prompt)
        .bind(data.issue_number)
        .bind(&skills_json)
        .bind(&issue_labels_json)
        .bind(&data.source)
        .bind(KIND_REVIEW_FIX)
        .bind(territory_globs_json.as_deref())
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Update mutable fields. Returns the updated row.
    ///
    /// `hours_saved_override` uses the three-state PATCH convention:
    /// `None` = don't touch, `Some(None)` = clear back to the default,
    /// `Some(Some(v))` = persist an override for this task.
    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        position: Option<i64>,
        status: Option<&str>,
        hours_saved_override: Option<Option<f64>>,
    ) -> Result<Self, sqlx::Error> {
        let existing = Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let new_position = position.unwrap_or(existing.position);
        let new_status = status.unwrap_or(&existing.status);
        let new_hours_override = hours_saved_override.unwrap_or(existing.hours_saved_override);

        sqlx::query(
            "UPDATE worker_tasks
                SET position             = ?2,
                    status               = ?3,
                    hours_saved_override = ?4
              WHERE id = ?1",
        )
        .bind(id)
        .bind(new_position)
        .bind(new_status)
        .bind(new_hours_override)
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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

    /// Count worker tasks that hold an open PR slot: `in_review` (waiting for
    /// reviewer) and `approved` (approved but not yet merged). Both consume
    /// the worker's cap — a worker becomes idle only when its PR merges (#472),
    /// so leaving approved out would silently relax the serial-per-worker rule.
    pub async fn count_in_review(pool: &SqlitePool, worker_id: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE worker_id = ?1 AND status IN ('in_review', 'approved')",
        )
        .bind(worker_id)
        .fetch_one(pool)
        .await
    }

    /// Count of worker tasks grouped by status, across all workers. Feeds
    /// `/api/metrics` (Prometheus) so the fleet stack can graph per-instance
    /// task throughput and queue depth. Returns every valid status even when
    /// the count is zero so the exposition stays stable across scrapes.
    pub async fn counts_by_status(pool: &SqlitePool) -> Result<Vec<(String, i64)>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, i64)>(
            "SELECT status, COUNT(*) AS n
               FROM worker_tasks
               GROUP BY status",
        )
        .fetch_all(pool)
        .await?;

        let mut by_status: HashMap<String, i64> = rows.into_iter().collect();
        let all = [
            STATUS_QUEUED,
            STATUS_IN_PROGRESS,
            STATUS_IN_REVIEW,
            STATUS_APPROVED,
            STATUS_DONE,
            STATUS_FAILED,
        ];
        Ok(all
            .into_iter()
            .map(|s| (s.to_string(), by_status.remove(s).unwrap_or(0)))
            .collect())
    }

    /// All in-progress tasks that have a workspace assigned (across all workers).
    /// Used by the pr_monitor to sweep for PRs created outside the app.
    pub async fn find_all_in_progress_with_workspace(
        pool: &SqlitePool,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
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

    /// Delete all active (queued / in_progress / in_review / approved) tasks
    /// linked to the given workspace. Called when a workspace is hard-deleted
    /// so orphaned tasks do not leave cards stuck on the kanban board.
    /// Idempotent: returns 0 if no matching tasks exist.
    pub async fn delete_active_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "DELETE FROM worker_tasks
               WHERE workspace_id = ?1
                 AND status IN ('queued', 'in_progress', 'in_review', 'approved')",
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
    /// (`in_progress`, `in_review`, `approved`). Used to distinguish healthy
    /// workspaces from orphans left behind by a failed start.
    pub async fn workspace_has_active_task(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
               FROM worker_tasks
               WHERE workspace_id = ?1
                 AND status IN ('in_progress', 'in_review', 'approved')",
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
                    wt.issue_number, wt.status, wt.workspace_id, wt.skills, wt.issue_labels, wt.source,
                    wt.created_at, wt.review_result, wt.failure_reason,
                    wt.hours_saved_override, wt.result_summary, wt.deliverable_ref,
                    wt.source_task_id, wt.territory_globs
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

    /// Find the first active task (queued, in_progress, in_review, or
    /// approved) for the given repo and issue number, across all workers.
    /// Used to detect duplicate issue assignments before creating a new task.
    pub async fn find_active_by_issue(
        pool: &SqlitePool,
        repo_id: Uuid,
        issue_number: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
               FROM worker_tasks
               WHERE repo_id = ?1
                 AND issue_number = ?2
                 AND status IN ('queued', 'in_progress', 'in_review', 'approved')
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

    /// The task's `kind`, if any (`'review_fix'` for orchestrator-dispatched
    /// author fix tasks; NULL for regular work).
    pub async fn kind(pool: &SqlitePool, id: Uuid) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>("SELECT kind FROM worker_tasks WHERE id = ?1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map(Option::flatten)
    }

    /// First still-pending (queued / in_progress) review-fix task for a PR,
    /// across all workers. Duplicate-dispatch guard: while one remediation is
    /// pending, no second one may be dispatched for the same PR — regardless
    /// of how many review rounds have completed in the meantime.
    pub async fn find_pending_review_fix_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, WorkerTask>(
            "SELECT id, worker_id, repo_id, position, title, prompt,
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
               FROM worker_tasks
               WHERE issue_number = ?1
                 AND repo_id = ?2
                 AND kind = 'review_fix'
                 AND status IN ('queued', 'in_progress')
               ORDER BY created_at ASC
               LIMIT 1",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_optional(pool)
        .await
    }

    /// Reviewer tasks (queued / in_progress / in_review) attached to a PR
    /// that is already merged or closed. Their workspace is not the PR's
    /// primary one, so `on_pr_merged` never reaches them — without a sweep
    /// the reviewer keeps polling GitHub for a PR that will never accept its
    /// review, hanging for hours and blocking its queue behind the doomed
    /// run. Returns `(task_id, worker_id, workspace_id, status)` rows so the
    /// caller can stop the workspace, close the task, mark the round
    /// superseded, and offer the freed worker its next queued task.
    pub async fn find_reviewer_tasks_for_finished_prs(
        pool: &SqlitePool,
    ) -> Result<Vec<(Uuid, Uuid, Option<Uuid>, String)>, sqlx::Error> {
        sqlx::query_as::<_, (Uuid, Uuid, Option<Uuid>, String)>(
            "SELECT wt.id, wt.worker_id, wt.workspace_id, wt.status
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
               JOIN pull_requests pr
                 ON pr.repo_id = wt.repo_id
                AND pr.pr_number = wt.issue_number
              WHERE w.role = 'reviewer'
                AND wt.status IN ('queued', 'in_progress', 'in_review')
                AND pr.pr_status IN ('merged', 'closed')",
        )
        .fetch_all(pool)
        .await
    }

    /// Close review-fix tasks whose PR is already merged or closed: the
    /// remediation's reason to exist is gone. Only `in_review` tasks are
    /// touched — the primary merge path (`on_pr_merged`) never sees them
    /// because they live in their own workspace, not the PR's primary one.
    /// Returns the affected (task_id, worker_id) pairs so the caller can
    /// offer freed workers their next queued task.
    pub async fn complete_review_fix_tasks_for_merged_prs(
        pool: &SqlitePool,
    ) -> Result<Vec<(Uuid, Uuid)>, sqlx::Error> {
        let stale = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT DISTINCT wt.id, wt.worker_id
               FROM worker_tasks wt
               JOIN pull_requests pr
                 ON pr.repo_id = wt.repo_id
                AND pr.pr_number = wt.issue_number
              WHERE wt.kind = 'review_fix'
                AND wt.status = 'in_review'
                AND pr.pr_status IN ('merged', 'closed')",
        )
        .fetch_all(pool)
        .await?;

        for (task_id, _) in &stale {
            sqlx::query(
                "UPDATE worker_tasks SET status = 'done' WHERE id = ?1 AND status = 'in_review'",
            )
            .bind(task_id)
            .execute(pool)
            .await?;
        }
        Ok(stale)
    }

    /// Loop activity snapshot for a PR, feeding the kanban card's loop badge:
    /// - `reviewer`: status of the active reviewer task ('queued' | 'running')
    /// - `fix`: status of the pending review-fix task ('queued' | 'running')
    /// - `last_activity_at`: newest completed_at/created_at across the PR's
    ///   reviewer and fix tasks — the reference point for stall detection.
    pub async fn loop_activity_for_pr(
        pool: &SqlitePool,
        pr_number: i64,
        repo_id: Uuid,
    ) -> Result<(Option<String>, Option<String>, Option<DateTime<Utc>>), sqlx::Error> {
        let reviewer = sqlx::query_scalar::<_, String>(
            "SELECT wt.status
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
              WHERE w.role = 'reviewer'
                AND wt.issue_number = ?1
                AND wt.repo_id = ?2
                AND wt.status IN ('queued', 'in_progress')
              ORDER BY wt.created_at ASC
              LIMIT 1",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_optional(pool)
        .await?;

        let fix = sqlx::query_scalar::<_, String>(
            "SELECT status
               FROM worker_tasks
              WHERE issue_number = ?1
                AND repo_id = ?2
                AND kind = 'review_fix'
                AND status IN ('queued', 'in_progress')
              ORDER BY created_at ASC
              LIMIT 1",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_optional(pool)
        .await?;

        let to_activity = |status: Option<String>| {
            status.map(|s| {
                if s == STATUS_IN_PROGRESS {
                    "running".to_string()
                } else {
                    "queued".to_string()
                }
            })
        };

        let last_activity_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
            "SELECT MAX(COALESCE(wt.completed_at, wt.created_at))
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
              WHERE wt.issue_number = ?1
                AND wt.repo_id = ?2
                AND (w.role = 'reviewer' OR wt.kind = 'review_fix')",
        )
        .bind(pr_number)
        .bind(repo_id)
        .fetch_one(pool)
        .await?;

        Ok((to_activity(reviewer), to_activity(fix), last_activity_at))
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
                    issue_number, status, workspace_id, skills, issue_labels, source,
                    created_at, review_result, failure_reason,
                    hours_saved_override, result_summary, deliverable_ref,
                    source_task_id, territory_globs
               FROM worker_tasks
               WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(updated)
    }

    /// Persist what a finished non-developer run left behind: the agent's
    /// final message and (for designers with commits) the pushed remote ref.
    /// Either side may be NULL; calling with both NULL is a no-op by value.
    pub async fn record_deliverable(
        pool: &SqlitePool,
        id: Uuid,
        result_summary: Option<&str>,
        deliverable_ref: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE worker_tasks
                SET result_summary = ?2, deliverable_ref = ?3
              WHERE id = ?1",
        )
        .bind(id)
        .bind(result_summary)
        .bind(deliverable_ref)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Finished designer deliverables that no handoff task consumes yet,
    /// newest first. A deliverable exists when the run left a summary or a
    /// pushed ref; the NOT EXISTS clause is the "already taken" guard.
    pub async fn find_pending_design_handoffs(
        pool: &SqlitePool,
    ) -> Result<Vec<PendingDesignHandoff>, sqlx::Error> {
        sqlx::query_as::<_, PendingDesignHandoff>(
            "SELECT wt.id AS task_id, wt.repo_id, wt.title, wt.issue_number,
                    w.name AS worker_name, w.emoji AS worker_emoji,
                    wt.deliverable_ref, wt.result_summary, wt.completed_at
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
              WHERE w.role = 'designer'
                AND wt.status = 'done'
                AND (wt.deliverable_ref IS NOT NULL
                     OR wt.result_summary IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM worker_tasks h
                                 WHERE h.source_task_id = wt.id)
              ORDER BY COALESCE(wt.completed_at, wt.created_at) DESC",
        )
        .fetch_all(pool)
        .await
    }

    /// The handoff task consuming a given designer task's deliverable, if
    /// any. Powers both the double-handoff guard and the "sent to X" state
    /// on the designer's done card.
    pub async fn find_handoff_for_source(
        pool: &SqlitePool,
        source_task_id: Uuid,
    ) -> Result<Option<HandoffInfo>, sqlx::Error> {
        sqlx::query_as::<_, HandoffInfo>(
            "SELECT wt.id AS task_id, wt.worker_id, w.name AS worker_name,
                    wt.status
               FROM worker_tasks wt
               JOIN workers w ON wt.worker_id = w.id
              WHERE wt.source_task_id = ?1
              ORDER BY wt.created_at ASC
              LIMIT 1",
        )
        .bind(source_task_id)
        .fetch_optional(pool)
        .await
    }

    /// Append a design-handoff task at the end of the worker's queue:
    /// like [`Self::append`] but tagged `kind = 'design_handoff'` and linked
    /// to the designer task it consumes.
    pub async fn append_design_handoff(
        pool: &SqlitePool,
        worker_id: Uuid,
        data: &CreateWorkerTask,
        source_task_id: Uuid,
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
                  issue_number, status, skills, source, kind, source_task_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, ?11)",
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
        .bind(KIND_DESIGN_HANDOFF)
        .bind(source_task_id)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Add LLM usage from a just-closed execution process to whichever task
    /// currently owns the workspace that hosted it. Additive so retries and
    /// follow-ups on the same workspace accumulate into a single running
    /// total. No-op when no task points at the workspace (the process ran
    /// under an orphaned or shared workspace) or when every field is zero.
    ///
    /// The `session_id` is resolved to a `workspace_id` in the same
    /// statement so callers don't have to preload it.
    ///
    /// Invariants the caller must uphold:
    /// - **At most one task per workspace.** `worker_tasks.workspace_id` has
    ///   no `UNIQUE` constraint at the DB level, so if two rows ever pointed
    ///   at the same workspace the delta would be applied to both. Today the
    ///   task→workspace mapping is 1:1 by construction; if that ever changes,
    ///   this rollup must be revisited.
    /// - **Called at most once per `execution_process.id`.** The write is
    ///   additive (not idempotent), so a second call for the same process
    ///   would double-count. The caller is the exit monitor in
    ///   `local-deployment::container::persist_execution_process_usage`,
    ///   which runs exactly once per process; any new caller must preserve
    ///   that guarantee (e.g. by gating on `execution_processes.cost_usd IS
    ///   NULL` via `set_usage`).
    pub async fn add_usage_delta_by_session(
        pool: &SqlitePool,
        session_id: Uuid,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        cache_creation_tokens: Option<i64>,
        cache_read_tokens: Option<i64>,
        cost_usd: Option<f64>,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE worker_tasks
                SET input_tokens_total          = COALESCE(input_tokens_total, 0)
                                                    + COALESCE(?2, 0),
                    output_tokens_total         = COALESCE(output_tokens_total, 0)
                                                    + COALESCE(?3, 0),
                    cache_creation_tokens_total = COALESCE(cache_creation_tokens_total, 0)
                                                    + COALESCE(?4, 0),
                    cache_read_tokens_total     = COALESCE(cache_read_tokens_total, 0)
                                                    + COALESCE(?5, 0),
                    cost_usd_total              = COALESCE(cost_usd_total, 0)
                                                    + COALESCE(?6, 0)
              WHERE workspace_id = (
                  SELECT workspace_id FROM sessions WHERE id = ?1
              )",
        )
        .bind(session_id)
        .bind(input_tokens)
        .bind(output_tokens)
        .bind(cache_creation_tokens)
        .bind(cache_read_tokens)
        .bind(cost_usd)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Read the rolled-up token totals and USD for a task. Returned as an
    /// `(input, output, cache_creation, cache_read, cost_usd)` tuple; all
    /// slots are `None` when the task never had any usage recorded.
    pub async fn usage_totals(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<
        (
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<f64>,
        ),
        sqlx::Error,
    > {
        let row = sqlx::query_as::<
            _,
            (
                Option<i64>,
                Option<i64>,
                Option<i64>,
                Option<i64>,
                Option<f64>,
            ),
        >(
            "SELECT input_tokens_total, output_tokens_total,
                    cache_creation_tokens_total, cache_read_tokens_total,
                    cost_usd_total
               FROM worker_tasks
              WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?
        .unwrap_or((None, None, None, None, None));
        Ok(row)
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
