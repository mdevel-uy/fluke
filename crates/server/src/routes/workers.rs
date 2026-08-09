use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use db::models::{
    agent_action::{self, AgentAction},
    execution_process::ExecutionProcess,
    file::File,
    merge::MergeStatus,
    pull_request::PullRequest,
    repo::Repo,
    review_round::ReviewRound,
    worker::{
        CreateWorker, ROLE_ANALYST, ROLE_DESIGNER, ROLE_DEVELOPER, ROLE_REVIEWER, UpdateWorker,
        Worker,
    },
    worker_task::{self, CreateWorkerTask, HandoffInfo, PendingDesignHandoff, WorkerTask},
    workspace::Workspace,
};
use deployment::Deployment;
use git_host::{GitHostProvider, GitHostService, github::GhCli};
use serde::{Deserialize, Deserializer, Serialize};
use services::services::{
    agent_actions_drain,
    container::ContainerService,
    design_artifacts, quick_action_prompts,
    repo_issues::RepoIssuesService,
    territory,
    worker_orchestrator::{self, StartError},
};
use tokio::task;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Guard rails for `hours_saved_override`. Kept in lockstep with the client
/// clamps in `useValueGeneratedSettingsStore` so the server rejects the same
/// range the UI already refuses to submit.
const MIN_HOURS_SAVED_OVERRIDE: f64 = 0.5;
const MAX_HOURS_SAVED_OVERRIDE: f64 = 80.0;

#[derive(Debug, Serialize, TS)]
pub struct WorkerResponse {
    pub id: Uuid,
    pub name: String,
    pub emoji: String,
    pub soul: String,
    pub role: String,
    #[ts(optional)]
    pub model: Option<String>,
    /// Whether the worker has a personal GitHub PAT stored. The token itself
    /// is never exposed — the UI shows this boolean so the form can render a
    /// masked placeholder and let the user replace or clear it.
    pub has_github_pat: bool,
    /// GitHub login the stored PAT belongs to (resolved at validation time),
    /// or `null` when no PAT is stored. Lets the UI show which identity the
    /// worker acts as, and surface identity clashes (reviewer == PR author).
    #[ts(optional, type = "string | null")]
    pub github_login: Option<String>,
    /// Per-worker override for plan mode. `null` = follow the global setting;
    /// `true` = force plan mode on; `false` = force plan mode off.
    #[ts(optional, type = "boolean | null")]
    pub plan_mode: Option<bool>,
    /// Soft-delete state. `false` = active (shown in the main listing);
    /// `true` = archived (moved to the "archived" section, skipped by
    /// orchestrator lookups, can be restored or purged from there).
    pub archived: bool,
    pub active_workspace_id: Option<Uuid>,
    #[ts(type = "number")]
    pub queued_count: i64,
    #[ts(type = "number")]
    pub completed_count: i64,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
pub struct WorkerTaskResponse {
    pub id: Uuid,
    pub worker_id: Uuid,
    pub repo_id: Uuid,
    #[ts(type = "number")]
    pub position: i64,
    pub title: String,
    pub prompt: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub status: String,
    pub workspace_id: Option<Uuid>,
    /// Skills selected for this task (stored as JSON array, exposed as array).
    pub skills: Vec<String>,
    /// GitHub labels to apply to every issue the analyst creates as part of
    /// this task (stored as JSON array, exposed as array).
    pub issue_labels: Vec<String>,
    /// URL of the most recent pull request tracked for this task's workspace,
    /// or `null` when no PR has been created yet.
    pub pr_url: Option<String>,
    /// State of the most recent PR: `"open" | "merged" | "closed"`, or
    /// `null` when there is no tracked PR.
    pub pr_state: Option<String>,
    /// Mergeable state: "mergeable", "conflicting", "unknown", or null.
    pub pr_mergeable: Option<String>,
    /// Origin of the task: `"kanban"` or `"desk"`.
    pub source: String,
    /// TL reviewer's verdict: "approved" | "changes_requested" | null.
    /// Set by pr_monitor when the PR review state is detected.
    pub review_result: Option<String>,
    /// Live state of the review loop for an `in_review` task with an open PR:
    /// "review_queued" | "reviewing" | "fix_queued" | "fixing" |
    /// "awaiting_review" | "stalled" | "developer_running", or null when the
    /// loop has nothing pending (e.g. approved and waiting for a human merge,
    /// or the task is not in review). "stalled" means no round is active, no
    /// fix is pending, there is no approval, and nothing has moved for over
    /// five minutes — the board's way of saying "nothing visible" must never
    /// hide "broken". "developer_running" means the task was approved and the
    /// developer's own coding agent is running a manual follow-up on the
    /// workspace (issue #471): the "approved" badge stays, this state adds
    /// the "in-flight" signal next to it.
    pub loop_state: Option<String>,
    /// Why the task failed, when status == "failed". Recorded by the
    /// orchestrator at the moment of failure; null otherwise.
    pub failure_reason: Option<String>,
    /// Per-task override for the estimated man-hours saved. `null` = use the
    /// installation default; a number replaces the default for aggregation
    /// (see `value_generated_summary`).
    #[ts(type = "number | null")]
    pub hours_saved_override: Option<f64>,
    /// The agent's final message, captured when a non-developer task
    /// finished OK. Abstract of the deliverable; null otherwise.
    pub result_summary: Option<String>,
    /// Remote ref (`design/<n>-<slug>`) holding a designer deliverable, or
    /// null when the run produced no commits / for non-designer tasks.
    pub deliverable_ref: Option<String>,
    /// On a design-handoff task: the designer task whose deliverable this
    /// task consumes.
    pub source_task_id: Option<Uuid>,
    /// On a designer task whose deliverable was handed off: where it went.
    /// Powers the "sent to X" state and the double-handoff guard client-side.
    #[ts(optional, type = "HandoffTaskInfo | null")]
    pub handoff: Option<HandoffTaskInfo>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}

/// The handoff task consuming a designer deliverable, as exposed on the
/// source task's response.
#[derive(Debug, Serialize, TS)]
pub struct HandoffTaskInfo {
    pub task_id: Uuid,
    pub worker_id: Uuid,
    pub worker_name: String,
    pub status: String,
}

impl From<HandoffInfo> for HandoffTaskInfo {
    fn from(info: HandoffInfo) -> Self {
        Self {
            task_id: info.task_id,
            worker_id: info.worker_id,
            worker_name: info.worker_name,
            status: info.status,
        }
    }
}

async fn worker_task_to_response(
    pool: &sqlx::SqlitePool,
    task: WorkerTask,
) -> Result<WorkerTaskResponse, ApiError> {
    let (pr_url, pr_state, pr_mergeable, open_pr_number) = match task.workspace_id {
        Some(workspace_id) => {
            let prs = PullRequest::find_by_workspace_id(pool, workspace_id).await?;
            match prs.into_iter().next() {
                Some(pr) => {
                    let open_pr_number =
                        matches!(pr.pr_status, MergeStatus::Open).then_some(pr.pr_number);
                    (
                        Some(pr.pr_url),
                        Some(merge_status_str(&pr.pr_status)),
                        pr.pr_mergeable,
                        open_pr_number,
                    )
                }
                None => (None, None, None, None),
            }
        }
        None => (None, None, None, None),
    };

    // Live loop state, only where it means something: an in_review or approved
    // task whose PR is still open. Everything else renders from status +
    // review_result. Approved is included because a manual follow-up on an
    // already-approved task still surfaces "developer_running".
    let loop_state = match open_pr_number {
        Some(pr_number)
            if task.status == worker_task::STATUS_IN_REVIEW
                || task.status == worker_task::STATUS_APPROVED =>
        {
            let (reviewer, fix, last_activity) =
                WorkerTask::loop_activity_for_pr(pool, pr_number, task.repo_id).await?;
            // A manual follow-up on an already-approved task (see #471) keeps
            // the developer's WorkerTask on `in_review` — so the reviewer/fix
            // ledger says "quiet" while the developer's coding agent is
            // actually running on the workspace. Peek at the workspace's
            // execution processes to surface that activity as its own loop
            // state, without dropping the "approved" verdict badge.
            let developer_agent_running = match task.workspace_id {
                Some(workspace_id) => {
                    ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
                        pool,
                        workspace_id,
                    )
                    .await
                    .unwrap_or(false)
                }
                None => false,
            };
            compute_loop_state(&task, reviewer, fix, last_activity, developer_agent_running)
        }
        _ => None,
    };

    let skills: Vec<String> = serde_json::from_str(&task.skills).unwrap_or_default();
    let issue_labels: Vec<String> = serde_json::from_str(&task.issue_labels).unwrap_or_default();

    // Handoff state only exists for tasks that hold a deliverable (designer
    // tasks by construction), so the extra query never runs for the rest of
    // the board.
    let handoff = if task.result_summary.is_some() || task.deliverable_ref.is_some() {
        WorkerTask::find_handoff_for_source(pool, task.id)
            .await?
            .map(HandoffTaskInfo::from)
    } else {
        None
    };

    Ok(WorkerTaskResponse {
        id: task.id,
        worker_id: task.worker_id,
        repo_id: task.repo_id,
        position: task.position,
        title: task.title,
        prompt: task.prompt,
        issue_number: task.issue_number,
        status: task.status,
        workspace_id: task.workspace_id,
        skills,
        issue_labels,
        pr_url,
        pr_state,
        pr_mergeable,
        source: task.source,
        review_result: task.review_result,
        loop_state,
        failure_reason: task.failure_reason,
        hours_saved_override: task.hours_saved_override,
        result_summary: task.result_summary,
        deliverable_ref: task.deliverable_ref,
        source_task_id: task.source_task_id,
        handoff,
        created_at: task.created_at,
    })
}

/// How long the loop may show no activity for an in_review open PR before the
/// board flags it as stalled.
const LOOP_STALL_THRESHOLD_SECS: i64 = 300;

/// Derive the loop badge for an in_review task with an open PR from the PR's
/// reviewer/fix activity plus whether the developer's own coding agent is
/// currently running on the workspace. Precedence: a running/queued fix beats
/// the reviewer (remediation is the actionable half), an approval means the
/// review loop is done (no verdict-side badge — the "approved" chip already
/// says it), and silence beyond the threshold is a stall, never a blank.
///
/// The `fix` slot has two sources today: a legacy separate `review_fix` task
/// (drained via `loop_activity_for_pr`), and — post issue #473 — the primary
/// path where remediation is dispatched as a system follow-up on the
/// developer task's own workspace. In the latter case `fix` is `None` because
/// there is no separate task, so we infer `"fixing"` from
/// `developer_agent_running` when the last verdict was `changes_requested`.
///
/// Exception on top of "approved → no badge": if the developer is running a
/// manual follow-up (issue #471), the card still needs to reflect activity.
/// Emit `"developer_running"` — the verdict chip stays as-is next to it, so
/// the human sees "approved AND working" instead of a mute card.
fn compute_loop_state(
    task: &WorkerTask,
    reviewer: Option<String>,
    fix: Option<String>,
    last_activity: Option<DateTime<Utc>>,
    developer_agent_running: bool,
) -> Option<String> {
    match fix.as_deref() {
        Some("running") => return Some("fixing".to_string()),
        Some("queued") => return Some("fix_queued".to_string()),
        _ => {}
    }
    // Primary #473 path: remediation runs as a system follow-up on the
    // developer's own workspace, so no separate `fix` task exists. When the
    // last verdict was changes_requested and the developer's agent is live,
    // that IS the remediation — surface it as `"fixing"`. The verdict badge
    // stays "changes_requested" until pr_monitor writes the fresh verdict
    // from the next reviewer round.
    if developer_agent_running && task.review_result.as_deref() == Some("changes_requested") {
        return Some("fixing".to_string());
    }
    match reviewer.as_deref() {
        Some("running") => return Some("reviewing".to_string()),
        Some("queued") => return Some("review_queued".to_string()),
        _ => {}
    }
    if task.review_result.as_deref() == Some("approved") {
        if developer_agent_running {
            return Some("developer_running".to_string());
        }
        return None;
    }
    let reference = last_activity.unwrap_or(task.created_at);
    if (Utc::now() - reference).num_seconds() > LOOP_STALL_THRESHOLD_SECS {
        Some("stalled".to_string())
    } else {
        Some("awaiting_review".to_string())
    }
}

fn merge_status_str(status: &MergeStatus) -> String {
    match status {
        MergeStatus::Open => "open".to_string(),
        MergeStatus::Merged => "merged".to_string(),
        MergeStatus::Closed => "closed".to_string(),
        MergeStatus::Unknown => "unknown".to_string(),
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkerRequest {
    pub name: String,
    pub emoji: String,
    pub soul: String,
    #[ts(optional)]
    pub role: Option<String>,
    #[ts(optional)]
    pub model: Option<String>,
    /// Optional GitHub PAT to authenticate this worker's push/PR/review
    /// operations. Empty string or omitted → fall back to global gh auth.
    /// Validated against `/user` before persisting; never returned by the API.
    #[ts(optional)]
    pub github_pat: Option<String>,
    /// Per-worker override for plan mode. Omitted or `null` = follow global;
    /// `true` = force plan mode on; `false` = force plan mode off.
    #[ts(optional, type = "boolean | null")]
    pub plan_mode: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateWorkerRequest {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub soul: Option<String>,
    #[ts(optional)]
    pub role: Option<String>,
    /// `undefined` = no change; `null` = clear to global default; `string` = set override
    #[serde(default, deserialize_with = "deserialize_double_option")]
    #[ts(optional, type = "string | null")]
    pub model: Option<Option<String>>,
    /// `undefined` = don't touch PAT; `null` = clear (fall back to global gh);
    /// `string` = new PAT (validated before persisting).
    #[serde(default, deserialize_with = "deserialize_double_option")]
    #[ts(optional, type = "string | null")]
    pub github_pat: Option<Option<String>>,
    /// `undefined` = don't touch; `null` = clear the override (follow global);
    /// `true` / `false` = force plan mode on/off for this worker.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    #[ts(optional, type = "boolean | null")]
    pub plan_mode: Option<Option<bool>>,
}

/// Distinguish a missing field from an explicit `null` for `Option<Option<T>>`.
/// Serde alone collapses both to the outer `None`; this wrapper preserves the
/// two states so the PATCH handler can tell "don't touch" from "clear".
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkerTaskRequest {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    #[ts(type = "number | null", optional)]
    pub issue_number: Option<i64>,
    /// Skills to associate with this task. Each skill name must correspond to
    /// an installed skill in `~/.claude/skills`. The instructions are appended
    /// to the stored prompt so the agent receives them automatically.
    #[ts(optional)]
    pub skills: Option<Vec<String>>,
    /// GitHub labels that the analyst must apply to every issue created as
    /// part of this request. Empty / whitespace-only entries are dropped
    /// server-side; the surviving list is both persisted and appended to the
    /// prompt as an instruction so the agent uses `add_label` after creating
    /// each issue.
    #[ts(optional)]
    pub issue_labels: Option<Vec<String>>,
    /// When true, skip the duplicate-assignment guard and create the task anyway.
    #[serde(default)]
    #[ts(optional)]
    pub force_duplicate: Option<bool>,
    /// Origin of the task: `"kanban"` (default) or `"desk"` for Analyst Desk
    /// requests.
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
    /// UUIDs de adjuntos previamente subidos vía POST /api/attachments/upload.
    /// El backend resuelve los file_path y los incluye en el contexto del worker.
    #[serde(default)]
    #[ts(optional)]
    pub attachment_ids: Option<Vec<Uuid>>,
}

/// Returned by `GET /api/workers/active-issue-task` when an issue already has
/// an active task assigned to a worker.
#[derive(Debug, Serialize, TS)]
pub struct ActiveIssueTaskInfo {
    pub task_id: Uuid,
    pub worker_id: Uuid,
    pub worker_name: String,
    pub worker_emoji: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct ActiveIssueTaskQuery {
    pub repo_id: Uuid,
    pub issue_number: i64,
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateWorkerTaskRequest {
    #[ts(type = "number | null", optional)]
    pub position: Option<i64>,
    #[ts(optional)]
    pub status: Option<String>,
    /// Per-task override for the estimated man-hours saved by this task.
    /// Three-state PATCH: `undefined` = don't touch, `null` = clear back to
    /// the installation default, `number` = persist the override for this
    /// task. Values are clamped server-side to `[MIN, MAX]_HOURS_PER_TASK`.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    #[ts(optional, type = "number | null")]
    pub hours_saved_override: Option<Option<f64>>,
}

#[derive(Debug, Deserialize, TS)]
pub struct ReassignWorkerTaskRequest {
    pub target_worker_id: Uuid,
}

/// Hand a finished designer deliverable to an analyst. The prompt is
/// composed server-side from the handoff template — the caller only picks
/// the destination and optionally adds human guidance on top.
#[derive(Debug, Deserialize, TS)]
pub struct CreateDesignHandoffRequest {
    /// The designer task whose deliverable is being handed off.
    pub source_task_id: Uuid,
    /// Target analyst worker.
    pub worker_id: Uuid,
    /// Optional PM guidance appended to the orchestrator's template
    /// (priorities, business constraints). Never replaces the template.
    #[ts(optional)]
    pub note: Option<String>,
    /// Origin of the handoff: `"kanban"` (designer card) or `"desk"`
    /// (Analyst Desk picker). Defaults to kanban.
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
}

/// POST /api/workers/design-handoffs — turn a designer deliverable into a
/// queued analyst task. Both UI entry points (designer done card, Analyst
/// Desk picker) converge here so there is exactly one handoff mechanic.
pub async fn create_design_handoff(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateDesignHandoffRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let source_task = WorkerTask::find_by_id(pool, payload.source_task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Source task not found".into()))?;
    let source_worker = Worker::find_by_id(pool, source_task.worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Source worker not found".into()))?;

    if source_worker.role != ROLE_DESIGNER {
        return Err(ApiError::BadRequest(
            "Only designer tasks can be handed off".into(),
        ));
    }
    if source_task.status != worker_task::STATUS_DONE {
        return Err(ApiError::BadRequest(
            "Only finished designer tasks can be handed off".into(),
        ));
    }
    if source_task.result_summary.is_none() && source_task.deliverable_ref.is_none() {
        return Err(ApiError::UnprocessableEntity(
            "This designer task has no recorded deliverable to hand off".into(),
        ));
    }
    if let Some(existing) = WorkerTask::find_handoff_for_source(pool, source_task.id).await? {
        return Err(ApiError::Conflict(format!(
            "This design was already handed off to {} (status: {})",
            existing.worker_name, existing.status
        )));
    }

    let target = Worker::find_by_id(pool, payload.worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Target worker not found".into()))?;
    if target.role != ROLE_ANALYST {
        return Err(ApiError::BadRequest(
            "Design handoffs can only target analyst workers".into(),
        ));
    }
    if target.archived {
        return Err(ApiError::BadRequest("Target analyst is archived".into()));
    }

    let source = match payload.source.as_deref() {
        None => worker_task::SOURCE_KANBAN.to_string(),
        Some(s) if worker_task::is_valid_source(s) => s.to_string(),
        Some(s) => {
            return Err(ApiError::BadRequest(format!("Invalid source: {s}")));
        }
    };

    let prompt = quick_action_prompts::format_design_handoff_prompt(
        &source_task.title,
        source_task.issue_number,
        source_task.deliverable_ref.as_deref(),
        source_task.result_summary.as_deref(),
        payload.note.as_deref(),
    );
    let title = format!("Despiezar diseño: {}", source_task.title);

    let task = WorkerTask::append_design_handoff(
        pool,
        target.id,
        &CreateWorkerTask {
            repo_id: source_task.repo_id,
            title,
            prompt,
            issue_number: source_task.issue_number,
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source,
            territory_globs: Vec::new(),
        },
        source_task.id,
    )
    .await?;

    let response = worker_task_to_response(pool, task).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// A finished designer deliverable no analyst has taken yet, as served to
/// the Analyst Desk picker and the sprint board.
#[derive(Debug, Serialize, TS)]
pub struct PendingDesignHandoffResponse {
    pub task_id: Uuid,
    pub repo_id: Uuid,
    pub title: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub worker_name: String,
    pub worker_emoji: String,
    pub deliverable_ref: Option<String>,
    pub result_summary: Option<String>,
    #[ts(type = "Date | null")]
    pub completed_at: Option<DateTime<Utc>>,
}

impl From<PendingDesignHandoff> for PendingDesignHandoffResponse {
    fn from(p: PendingDesignHandoff) -> Self {
        Self {
            task_id: p.task_id,
            repo_id: p.repo_id,
            title: p.title,
            issue_number: p.issue_number,
            worker_name: p.worker_name,
            worker_emoji: p.worker_emoji,
            deliverable_ref: p.deliverable_ref,
            result_summary: p.result_summary,
            completed_at: p.completed_at,
        }
    }
}

/// GET /api/workers/design-handoffs/pending — finished designer deliverables
/// no analyst has taken yet. Feeds the Analyst Desk picker.
pub async fn list_pending_design_handoffs(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<PendingDesignHandoffResponse>>>, ApiError> {
    let pool = &deployment.db().pool;
    let pending = WorkerTask::find_pending_design_handoffs(pool).await?;
    let response: Vec<PendingDesignHandoffResponse> = pending.into_iter().map(Into::into).collect();
    Ok(ResponseJson(ApiResponse::success(response)))
}

fn is_valid_role(role: &str) -> bool {
    matches!(
        role,
        ROLE_DEVELOPER | ROLE_ANALYST | ROLE_REVIEWER | ROLE_DESIGNER
    )
}

async fn to_response(pool: &sqlx::SqlitePool, worker: Worker) -> Result<WorkerResponse, ApiError> {
    let active_workspace_id = Worker::active_workspace_id(pool, worker.id).await?;
    let queued_count = Worker::queued_task_count(pool, worker.id).await?;
    let completed_count = Worker::completed_task_count(pool, worker.id).await?;

    Ok(WorkerResponse {
        id: worker.id,
        name: worker.name,
        emoji: worker.emoji,
        soul: worker.soul,
        role: worker.role,
        model: worker.model,
        has_github_pat: worker.github_pat.is_some(),
        github_login: worker.github_login,
        plan_mode: worker.plan_mode,
        archived: worker.archived,
        active_workspace_id,
        queued_count,
        completed_count,
        created_at: worker.created_at,
    })
}

/// Validate a PAT by calling GitHub `/user`. Returns `Ok(login)` on success,
/// `Err(reason)` otherwise. Runs on a blocking thread because `gh` shells out.
async fn validate_github_pat(token: String) -> Result<String, String> {
    task::spawn_blocking(move || GhCli::new().validate_token(&token))
        .await
        .map_err(|e| format!("Failed to run validation: {e}"))?
        .map_err(|e| e.to_string())
}

pub async fn list_workers(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<WorkerResponse>>>, ApiError> {
    let pool = &deployment.db().pool;
    let workers = Worker::list_all(pool).await?;

    let mut out = Vec::with_capacity(workers.len());
    for w in workers {
        out.push(to_response(pool, w).await?);
    }
    Ok(ResponseJson(ApiResponse::success(out)))
}

pub async fn create_worker(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkerRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerResponse>>, ApiError> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let emoji = payload.emoji.trim();
    if emoji.is_empty() {
        return Err(ApiError::BadRequest("emoji is required".into()));
    }
    if let Some(role) = payload.role.as_deref() {
        if !is_valid_role(role) {
            return Err(ApiError::BadRequest(format!("Invalid role: {role}")));
        }
    }

    // Validate the PAT before touching the DB. Empty string is treated as
    // "no token" (same as omitted).
    let github_pat = normalize_pat(payload.github_pat);
    let mut github_login = None;
    if let Some(ref token) = github_pat {
        match validate_github_pat(token.clone()).await {
            Ok(login) => github_login = Some(login),
            Err(reason) => {
                return Err(ApiError::BadRequest(format!(
                    "GitHub PAT rejected: {reason}"
                )));
            }
        }
    }

    let pool = &deployment.db().pool;
    let worker = Worker::create(
        pool,
        &CreateWorker {
            name: name.to_string(),
            emoji: emoji.to_string(),
            soul: payload.soul,
            role: payload.role,
            model: payload.model.filter(|m| !m.is_empty()),
            github_pat,
            github_login,
            plan_mode: payload.plan_mode,
        },
    )
    .await?;

    let response = to_response(pool, worker).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn get_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<WorkerResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    let response = to_response(pool, worker).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn update_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
    Json(payload): Json<UpdateWorkerRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let existing = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    // Validate role value before touching the DB.
    let role = payload
        .role
        .as_deref()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());

    if let Some(ref r) = role {
        if !is_valid_role(r) {
            return Err(ApiError::BadRequest(format!("Invalid role: {r}")));
        }
        // Block role changes while tasks are in flight to avoid lifecycle confusion.
        if r != &existing.role && Worker::has_in_flight_tasks(pool, worker_id).await? {
            return Err(ApiError::Conflict(
                "Cannot change role while worker has tasks in progress or in review".into(),
            ));
        }
    }

    // Normalize model: Some(Some("")) → Some(None) (empty string clears the override)
    let model = payload.model.map(|m| m.filter(|s| !s.is_empty()));

    // Normalize PAT the same way, then validate a *new non-empty* value before
    // persisting. `None` (missing field) leaves it alone; `Some(None)` clears
    // without any GitHub round-trip.
    let github_pat = payload
        .github_pat
        .map(|opt| opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    // Keep login in lockstep with the PAT: new token → resolved login;
    // cleared token → cleared login; untouched token → untouched login.
    let github_login = match &github_pat {
        None => None,
        Some(None) => Some(None),
        Some(Some(token)) => match validate_github_pat(token.clone()).await {
            Ok(login) => Some(Some(login)),
            Err(reason) => {
                return Err(ApiError::BadRequest(format!(
                    "GitHub PAT rejected: {reason}"
                )));
            }
        },
    };

    let worker = Worker::update(
        pool,
        worker_id,
        &UpdateWorker {
            name: payload
                .name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            emoji: payload
                .emoji
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            soul: payload.soul,
            role,
            model,
            github_pat,
            github_login,
            plan_mode: payload.plan_mode,
        },
    )
    .await?;

    let response = to_response(pool, worker).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Empty / whitespace-only PAT is treated as "no token" — same as omitting
/// the field. Prevents a user from accidentally storing "" as their token.
fn normalize_pat(pat: Option<String>) -> Option<String> {
    pat.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub async fn delete_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let rows = Worker::delete(&deployment.db().pool, worker_id).await?;
    if rows == 0 {
        return Err(ApiError::BadRequest("Worker not found".into()));
    }
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Soft-delete a worker: flips `archived = 1` so the worker disappears from
/// the main listing but its row, tasks and workspace history remain.
///
/// Blocked when the worker still has an active workspace attached (an
/// unfinished task in progress). Idempotent: archiving an already-archived
/// worker is a no-op and returns 200.
pub async fn archive_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<WorkerResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    // Refuse to archive if the worker has an active workspace: the workspace
    // still points to this worker and the running agent would end up attached
    // to a hidden identity.
    if Worker::active_workspace_id(pool, worker_id)
        .await?
        .is_some()
    {
        return Err(ApiError::BadRequest(
            "Cannot archive a worker with an active workspace. Cancel or finish the task first."
                .into(),
        ));
    }

    if !worker.archived {
        Worker::set_archived(pool, worker_id, true).await?;
    }

    let refreshed = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;
    let response = to_response(pool, refreshed).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Restore an archived worker back to the active listing. Idempotent: a
/// worker that is already active stays active and the endpoint returns 200.
pub async fn unarchive_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<WorkerResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    if worker.archived {
        Worker::set_archived(pool, worker_id, false).await?;
    }

    let refreshed = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;
    let response = to_response(pool, refreshed).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// List every archived worker so the WorkersPage can render the "Workers
/// archivados" collapsible section.
pub async fn list_archived_workers(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<WorkerResponse>>>, ApiError> {
    let pool = &deployment.db().pool;
    let workers = Worker::list_archived(pool).await?;

    let mut out = Vec::with_capacity(workers.len());
    for w in workers {
        out.push(to_response(pool, w).await?);
    }
    Ok(ResponseJson(ApiResponse::success(out)))
}

#[derive(Debug, Serialize)]
pub struct DeleteAllArchivedResponse {
    pub deleted: i64,
}

/// Bulk-purge every archived worker in one shot. Runs a single SQLite
/// transaction that detaches any workspace still pointing at an archived
/// worker and then deletes the archived rows. Returns `{ deleted: N }` with
/// the number of workers that were removed; `0` is a valid, non-error result
/// when there was nothing to purge.
pub async fn delete_all_archived_workers(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<DeleteAllArchivedResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let deleted = Worker::delete_all_archived(pool).await?;
    Ok(ResponseJson(ApiResponse::success(
        DeleteAllArchivedResponse {
            deleted: deleted as i64,
        },
    )))
}

#[derive(Debug, Serialize)]
pub struct DeleteAllFailedTasksResponse {
    pub deleted: i64,
}

/// Bulk-prune every failed worker task (header action on the sidebar's
/// Failed section). `failed` is terminal — retries always create a fresh
/// task — so these cards are pure history; an incident burst leaves dozens
/// behind. Mirrors the archived purge: single DELETE, `{ deleted: N }`
/// response, `0` is a valid result when there was nothing to prune. The
/// tasks' archived workspaces are kept, same as the per-card delete — they
/// surface under Archived and its own purge covers them.
pub async fn delete_all_failed_tasks(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<DeleteAllFailedTasksResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let deleted = WorkerTask::delete_all_failed(pool).await?;
    Ok(ResponseJson(ApiResponse::success(
        DeleteAllFailedTasksResponse {
            deleted: deleted as i64,
        },
    )))
}

/// Clone an existing worker's identity (emoji, soul, role, model) into a new
/// worker. The duplicate is named `"Copia de {name}"` and starts empty — no
/// tasks or workspaces are copied. Returns 201 with the new worker, or 404
/// when the source worker does not exist.
///
/// The source worker's GitHub PAT is intentionally NOT copied: cloning a
/// second identity that shares the same credentials would undermine the
/// point of per-worker auth. The user must add a PAT explicitly on the
/// duplicate.
pub async fn duplicate_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;
    let Some(source) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok((
            StatusCode::NOT_FOUND,
            ResponseJson(ApiResponse::<WorkerResponse>::error("Worker not found")),
        )
            .into_response());
    };

    let created = Worker::create(
        pool,
        &CreateWorker {
            name: format!("Copia de {}", source.name),
            emoji: source.emoji,
            soul: source.soul,
            role: Some(source.role),
            model: source.model,
            github_pat: None,
            github_login: None,
            plan_mode: source.plan_mode,
        },
    )
    .await?;

    let response = to_response(pool, created).await?;
    Ok((
        StatusCode::CREATED,
        ResponseJson(ApiResponse::<WorkerResponse>::success(response)),
    )
        .into_response())
}

pub async fn list_worker_tasks(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<WorkerTaskResponse>>>, ApiError> {
    let pool = &deployment.db().pool;
    Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    let tasks = WorkerTask::list_by_worker(pool, worker_id).await?;
    let mut response = Vec::with_capacity(tasks.len());
    for task in tasks {
        response.push(worker_task_to_response(pool, task).await?);
    }
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Returns the first active task (queued / in_progress / in_review) for the
/// given repo + issue number, together with the assigned worker's display info.
/// Returns `null` when no active task exists for that issue.
pub async fn get_active_issue_task(
    State(deployment): State<DeploymentImpl>,
    Query(params): Query<ActiveIssueTaskQuery>,
) -> Result<ResponseJson<ApiResponse<Option<ActiveIssueTaskInfo>>>, ApiError> {
    let pool = &deployment.db().pool;
    match WorkerTask::find_active_by_issue(pool, params.repo_id, params.issue_number).await? {
        None => Ok(ResponseJson(ApiResponse::success(None))),
        Some(task) => {
            let worker = Worker::find_by_id(pool, task.worker_id)
                .await?
                .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;
            Ok(ResponseJson(ApiResponse::success(Some(
                ActiveIssueTaskInfo {
                    task_id: task.id,
                    worker_id: task.worker_id,
                    worker_name: worker.name,
                    worker_emoji: worker.emoji,
                    status: task.status,
                },
            ))))
        }
    }
}

/// Fire-and-forget mirror of a worker-task assignment change onto the
/// upstream GitHub issue. The local worker-task operation is canonical:
/// any `gh` failure (missing PAT scope, non-GitHub remote, closed issue,
/// unknown login) is logged as a warning and swallowed so an infra
/// hiccup never leaves an HTTP call hanging or the DB inconsistent with
/// the response we already returned. A no-op when both logins are
/// `None` — callers hand that combination in whenever a worker has no
/// `github_login` configured.
fn spawn_sync_issue_assignee(
    deployment: DeploymentImpl,
    repo_id: Uuid,
    issue_number: i64,
    add_login: Option<String>,
    remove_login: Option<String>,
) {
    if add_login.is_none() && remove_login.is_none() {
        return;
    }
    task::spawn(async move {
        let pool = &deployment.db().pool;
        if let Err(err) = RepoIssuesService::new()
            .edit_assignees(
                pool,
                repo_id,
                issue_number,
                add_login.as_deref(),
                remove_login.as_deref(),
            )
            .await
        {
            tracing::warn!(
                repo_id = %repo_id,
                issue_number,
                add_login = ?add_login,
                remove_login = ?remove_login,
                "GitHub assignee sync failed (best-effort): {}",
                err
            );
        }
    });
}

pub async fn create_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
    Json(payload): Json<CreateWorkerTaskRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    // Validate the referenced repo exists (surfaced as 400 rather than
    // a FK violation).
    deployment.repo().get_by_id(pool, payload.repo_id).await?;

    let title = payload.title.trim();
    if title.is_empty() {
        return Err(ApiError::BadRequest("title is required".into()));
    }
    let prompt = payload.prompt.trim();
    if prompt.is_empty() {
        return Err(ApiError::BadRequest("prompt is required".into()));
    }

    let skills = payload.skills.unwrap_or_default();
    // Sanitize the incoming labels: trim whitespace and drop empty entries so
    // a stray "  " or "" from the UI does not survive as a bogus label.
    let issue_labels: Vec<String> = payload
        .issue_labels
        .unwrap_or_default()
        .into_iter()
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .collect();

    let source = match payload.source.as_deref() {
        None => worker_task::SOURCE_KANBAN.to_string(),
        Some(s) if worker_task::is_valid_source(s) => s.to_string(),
        Some(s) => return Err(ApiError::BadRequest(format!("Invalid source: {s}"))),
    };

    // Resolve attachment IDs to absolute filesystem paths BEFORE creating the
    // task, so a missing UUID aborts the request without side effects (422).
    let attachment_ids = payload.attachment_ids.unwrap_or_default();
    let mut attachment_paths: Vec<String> = Vec::with_capacity(attachment_ids.len());
    for id in &attachment_ids {
        match File::find_by_id(pool, *id).await? {
            Some(file) => {
                let absolute = deployment.file().get_absolute_path(&file);
                attachment_paths.push(absolute.to_string_lossy().into_owned());
            }
            None => {
                return Err(ApiError::UnprocessableEntity(format!(
                    "Attachment not found: {id}"
                )));
            }
        }
    }

    // Append skill instructions and image references to the prompt so the
    // agent receives them.
    let mut final_prompt = prompt.to_string();
    if !attachment_paths.is_empty() {
        final_prompt.push_str("\n\nImágenes de referencia:");
        for path in &attachment_paths {
            final_prompt.push_str(&format!("\n- {path}"));
        }
    }
    for skill in &skills {
        final_prompt.push_str(&format!("\n\nUsá el skill /{skill} para esta tarea."));
    }
    if !issue_labels.is_empty() {
        let labels_list = issue_labels.join(", ");
        final_prompt.push_str(&format!(
            "\n\nAl crear los issues resultantes de esta solicitud, aplicales las siguientes etiquetas de GitHub: {labels_list}. Usá la herramienta add_label para agregarlas tras crear cada issue."
        ));
    }

    // Guard against duplicate assignments of the same GitHub issue.
    // Skip the check when the caller explicitly opts in with force_duplicate.
    if let Some(issue_number) = payload.issue_number {
        if !payload.force_duplicate.unwrap_or(false) {
            if let Some(existing) =
                WorkerTask::find_active_by_issue(pool, payload.repo_id, issue_number).await?
            {
                let existing_worker = Worker::find_by_id(pool, existing.worker_id)
                    .await?
                    .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;
                return Err(ApiError::Conflict(format!(
                    "Issue #{} is already assigned to {} {} (status: {}). \
                     Pass force_duplicate: true to override.",
                    issue_number, existing_worker.emoji, existing_worker.name, existing.status
                )));
            }
        }
    }

    // Parse the file territory declared in the issue body (issue #95). The
    // prompt at this point already carries the raw issue body plus the
    // per-request appendices (skills / labels / attachments), which live
    // OUTSIDE any `## Territorio` section — so the parser only ever sees the
    // analyst-authored territory.
    let territory_globs = territory::parse_territory_globs(prompt);

    let task = WorkerTask::append(
        pool,
        worker_id,
        &CreateWorkerTask {
            repo_id: payload.repo_id,
            title: title.to_string(),
            prompt: final_prompt,
            issue_number: payload.issue_number,
            skills,
            issue_labels,
            source,
            territory_globs,
        },
    )
    .await?;

    // Mirror the assignment onto GitHub best-effort. Guarded here (not inside
    // the helper) so the spawn cost is skipped when there's nothing to sync.
    if let (Some(issue_number), Some(login)) = (task.issue_number, worker.github_login.clone()) {
        spawn_sync_issue_assignee(
            deployment.clone(),
            task.repo_id,
            issue_number,
            Some(login),
            None,
        );
    }

    let response = worker_task_to_response(pool, task).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn update_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateWorkerTaskRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }

    if let Some(status) = payload.status.as_deref()
        && !worker_task::is_valid_status(status)
    {
        return Err(ApiError::BadRequest(format!("Invalid status: {status}")));
    }

    // Clamp the override server-side: mirrors the frontend guard rails so a
    // hand-crafted request cannot bypass the UI validation and land a
    // nonsensical FTE figure in the panel.
    let hours_override = match payload.hours_saved_override {
        None => None,
        Some(None) => Some(None),
        Some(Some(raw)) => {
            if !raw.is_finite() {
                return Err(ApiError::BadRequest(
                    "hours_saved_override must be a finite number".into(),
                ));
            }
            if !(MIN_HOURS_SAVED_OVERRIDE..=MAX_HOURS_SAVED_OVERRIDE).contains(&raw) {
                return Err(ApiError::BadRequest(format!(
                    "hours_saved_override must be between {MIN_HOURS_SAVED_OVERRIDE} and {MAX_HOURS_SAVED_OVERRIDE}"
                )));
            }
            Some(Some(raw))
        }
    };

    let updated = WorkerTask::update(
        pool,
        task_id,
        payload.position,
        payload.status.as_deref(),
        hours_override,
    )
    .await?;

    // Retry: a failed task moved back to `queued` should not wait for an
    // external poke (auto-advance, reconciler poll, manual Start) to run
    // again. Kick the worker in the background; conflicts (already busy,
    // in-review cap) are expected and simply leave the task queued.
    if existing.status == worker_task::STATUS_FAILED && updated.status == worker_task::STATUS_QUEUED
    {
        let deployment = deployment.clone();
        task::spawn(async move {
            match worker_orchestrator::try_take_next(
                deployment.config(),
                deployment.db(),
                deployment.container(),
                worker_id,
            )
            .await
            {
                Ok(started) => tracing::info!(
                    worker_id = %worker_id,
                    task_id = %started.task.id,
                    "Retried task started immediately"
                ),
                Err(e) if e.is_conflict() => {}
                Err(e) => tracing::warn!(
                    worker_id = %worker_id,
                    "Failed to auto-start retried task: {}",
                    e
                ),
            }
        });
    }

    let response = worker_task_to_response(pool, updated).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

#[derive(Debug, Serialize, TS)]
pub struct StartWorkerResponse {
    pub task: WorkerTaskResponse,
    pub workspace_id: Uuid,
}

#[derive(Debug, Serialize, TS)]
pub struct StartAllWorkersItemResponse {
    pub worker_id: Uuid,
    pub worker_name: String,
    pub started: bool,
    pub task_title: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct StartAllWorkersResponse {
    pub results: Vec<StartAllWorkersItemResponse>,
}

fn start_error_reason(err: &StartError) -> String {
    match err {
        StartError::NothingQueued => "nothing_queued".to_string(),
        StartError::AlreadyInProgress => "already_in_progress".to_string(),
        StartError::InReviewCapReached(_) => "in_review_cap_reached".to_string(),
        StartError::LicenseSuspended => "license_suspended".to_string(),
        _ => "error".to_string(),
    }
}

/// Iterate all workers and attempt to start the next queued task for each
/// eligible one. One failure does not block the others. Idempotent-friendly:
/// a second call simply finds nothing startable.
pub async fn start_all_workers(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<StartAllWorkersResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let workers = Worker::list_all(pool).await?;

    let mut results = Vec::with_capacity(workers.len());
    for worker in workers {
        let worker_name = worker.name.clone();
        let worker_id = worker.id;
        match worker_orchestrator::try_take_next(
            deployment.config(),
            deployment.db(),
            deployment.container(),
            worker_id,
        )
        .await
        {
            Ok(started) => {
                results.push(StartAllWorkersItemResponse {
                    worker_id,
                    worker_name,
                    started: true,
                    task_title: Some(started.task.title),
                    reason: None,
                });
            }
            Err(err) => {
                results.push(StartAllWorkersItemResponse {
                    worker_id,
                    worker_name,
                    started: false,
                    task_title: None,
                    reason: Some(start_error_reason(&err)),
                });
            }
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        StartAllWorkersResponse { results },
    )))
}

/// Attempt to take the next queued task for the worker and start an agent
/// run for it. Returns 409 when the worker is ineligible for a
/// task-content reason (already in_progress, nothing queued) and 429 when
/// the concurrent-agents cap is full — the frontend uses the 429 to show
/// the plan-upgrade CTA.
pub async fn start_worker(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<StartWorkerResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

    let started = worker_orchestrator::try_take_next(
        deployment.config(),
        deployment.db(),
        deployment.container(),
        worker_id,
    )
    .await
    .map_err(map_start_error)?;

    let task = worker_task_to_response(pool, started.task).await?;
    Ok(ResponseJson(ApiResponse::success(StartWorkerResponse {
        task,
        workspace_id: started.workspace_id,
    })))
}

fn map_start_error(err: StartError) -> ApiError {
    match err {
        StartError::WorkerNotFound => ApiError::BadRequest("Worker not found".into()),
        StartError::RepoNotFound => ApiError::BadRequest("Repo not found".into()),
        StartError::RepoMissingDefaultBranch(repo_name) => ApiError::BadRequest(format!(
            "Repo '{}' is missing a default target branch. Configure it in Settings \u{2192} Repos \u{2192} {} \u{2192} Default target branch",
            repo_name, repo_name
        )),
        StartError::NothingQueued => ApiError::Conflict("No queued tasks for worker".into()),
        StartError::AlreadyInProgress => {
            ApiError::Conflict("Worker already has a task in progress".into())
        }
        StartError::InReviewCapReached(cap) => {
            // 429 (not 409) so the frontend can distinguish a plan-cap hit
            // from other conflicts (already in progress, nothing queued) and
            // surface the upsell CTA instead of a generic error toast.
            ApiError::TooManyRequests(format!(
                "Concurrent-agents limit reached ({cap}). Task remains queued."
            ))
        }
        StartError::LicenseSuspended => ApiError::Conflict(
            "La licencia está suspendida; no se arrancan agentes nuevos. \
             Los datos y el historial siguen disponibles. Contactá a mkanban."
                .into(),
        ),
        StartError::Sqlx(e) => e.into(),
        StartError::Container(e) => e.into(),
        StartError::Workspace(e) => ApiError::Conflict(e.to_string()),
        StartError::DbWorkspace(e) => e.into(),
    }
}

pub async fn delete_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }
    if existing.status != worker_task::STATUS_QUEUED
        && existing.status != worker_task::STATUS_FAILED
        && existing.status != worker_task::STATUS_DONE
    {
        return Err(ApiError::Conflict(
            "Only queued, failed or done tasks can be deleted".into(),
        ));
    }

    // Snapshot the fields we need for the GitHub assignee sync BEFORE the
    // delete: after `WorkerTask::delete` the row is gone and we can no longer
    // recover the repo_id / issue_number. The worker lookup is best-effort —
    // if it fails we just skip the sync.
    let sync_target = if existing.issue_number.is_some() {
        Worker::find_by_id(pool, worker_id)
            .await
            .ok()
            .flatten()
            .and_then(|w| w.github_login)
            .map(|login| (existing.repo_id, existing.issue_number.unwrap(), login))
    } else {
        None
    };

    WorkerTask::delete(pool, task_id).await?;

    if let Some((repo_id, issue_number, login)) = sync_target {
        spawn_sync_issue_assignee(deployment.clone(), repo_id, issue_number, None, Some(login));
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Move a queued task to another worker's queue atomically. Only tasks in
/// `queued` state can be reassigned; anything already `in_progress` /
/// `in_review` / terminal must be cancelled first so the running workspace
/// is torn down cleanly (409 with an explanatory message).
pub async fn reassign_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<ReassignWorkerTaskRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }

    if payload.target_worker_id == worker_id {
        return Err(ApiError::BadRequest(
            "Target worker must differ from the current worker".into(),
        ));
    }

    // Validate target worker exists (surfaced as 400 rather than a FK violation).
    let target_worker = Worker::find_by_id(pool, payload.target_worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Target worker not found".into()))?;

    // Fail fast for non-queued tasks before opening a transaction, so the
    // client sees a precise message instead of a generic "not queued".
    if existing.status != worker_task::STATUS_QUEUED {
        return Err(ApiError::Conflict(format!(
            "Only queued tasks can be reassigned (current status: {}). \
             Cancel the task first, then reassign it.",
            existing.status
        )));
    }

    // Look up the source worker's login for the assignee swap. Fetched after
    // the status guard so we don't hit the DB for a request that will error.
    let source_worker = Worker::find_by_id(pool, worker_id).await?;

    // The atomic move: guarded by `status = 'queued'` inside the same
    // transaction so a concurrent claim cannot slip the task into
    // in_progress under our feet.
    let updated = WorkerTask::reassign_if_queued(pool, task_id, payload.target_worker_id)
        .await?
        .ok_or_else(|| {
            ApiError::Conflict(
                "Task was claimed by its worker just before reassignment. \
                 Cancel the task and try again."
                    .into(),
            )
        })?;

    // Mirror the assignment swap onto GitHub best-effort. Either login may be
    // `None` (worker without PAT) and the helper collapses to a no-op when
    // both are — a `--remove-assignee` without target still updates GitHub to
    // an unassigned issue.
    if let Some(issue_number) = updated.issue_number {
        spawn_sync_issue_assignee(
            deployment.clone(),
            updated.repo_id,
            issue_number,
            target_worker.github_login.clone(),
            source_worker.and_then(|w| w.github_login),
        );
    }

    let response = worker_task_to_response(pool, updated).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub async fn cancel_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }

    if existing.status != worker_task::STATUS_IN_PROGRESS
        && existing.status != worker_task::STATUS_IN_REVIEW
        && existing.status != worker_task::STATUS_APPROVED
    {
        return Err(ApiError::Conflict(
            "Only in_progress, in_review or approved tasks can be cancelled".into(),
        ));
    }

    if let Some(workspace_id) = existing.workspace_id {
        if let Ok(Some(workspace)) = Workspace::find_by_id(pool, workspace_id).await {
            deployment.container().try_stop(&workspace, false).await;
        }
    }

    WorkerTask::delete(pool, task_id).await?;

    // Free the worker's slot and offer it the next queued task. Without this
    // trigger a cancellation leaves the queue stalled: the other finish paths
    // (`on_pr_merged`, `on_agent_finished`, `dispatch_review_task`) all call
    // `try_take_next` themselves, but cancel is the only exit that used to
    // skip it — a queued reviewer/dev task behind the cancelled one would
    // then sit forever with the worker idle. Conflicts (nothing queued, cap
    // reached) are expected and swallowed just like the other call sites.
    let deployment_bg = deployment.clone();
    task::spawn(async move {
        match worker_orchestrator::try_take_next(
            deployment_bg.config(),
            deployment_bg.db(),
            deployment_bg.container(),
            worker_id,
        )
        .await
        {
            Ok(started) => tracing::info!(
                worker_id = %worker_id,
                task_id = %started.task.id,
                "Next task started after cancellation"
            ),
            Err(e) if e.is_conflict() => {}
            Err(e) => tracing::warn!(
                worker_id = %worker_id,
                "Failed to auto-start next task after cancellation: {}",
                e
            ),
        }
    });

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Roll-up returned by the surgical retry endpoint. Mirrors
/// [`agent_actions_drain::DrainResult`] as JSON.
#[derive(Debug, Serialize)]
pub struct RetryActionsResponse {
    pub done: usize,
    pub failed: usize,
    pub pending_remaining: usize,
}

/// Re-drive the outbox of a task: run `pending` / `failed` agent actions
/// against GitHub without re-running the coding agent. This is the surgical
/// retry that makes an infra hiccup on GitHub cheap to recover from — a single
/// POST here replays only the outstanding side effects and, on a definitive
/// failure, updates the task to `failed` with the same shape the finish hook
/// uses so the board tells one story.
pub async fn retry_worker_task_actions(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, ApiError> {
    let pool = &deployment.db().pool;

    // 1. Worker must exist.
    if Worker::find_by_id(pool, worker_id).await?.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            ResponseJson(ApiResponse::<RetryActionsResponse>::error(
                "Worker not found",
            )),
        )
            .into_response());
    }

    // 2. Task must exist and belong to this worker. Cross-worker requests are
    //    surfaced as 404 (not 400) so URL guessing never leaks that the task
    //    exists under a different worker.
    let task = match WorkerTask::find_by_id(pool, task_id).await? {
        Some(t) if t.worker_id == worker_id => t,
        _ => {
            return Ok((
                StatusCode::NOT_FOUND,
                ResponseJson(ApiResponse::<RetryActionsResponse>::error(
                    "Worker task not found",
                )),
            )
                .into_response());
        }
    };

    // 3. Refuse to interfere with an in-progress run: the finish hook is
    //    already responsible for draining and touching agent_actions from two
    //    places at once could corrupt attempt counters and row status.
    if task.status == worker_task::STATUS_IN_PROGRESS {
        return Err(ApiError::Conflict(
            "la task está en progreso, no se puede re-drenar".into(),
        ));
    }

    // 4. Nothing to retry means we surface a precise 409 instead of a 200
    //    with `done=0`, so the caller sees the state as intentional.
    let pending = AgentAction::find_pending_or_failed_for_task(pool, task_id).await?;
    if pending.is_empty() {
        return Err(ApiError::Conflict(
            "no hay acciones pendientes o fallidas para esta task".into(),
        ));
    }

    // 5. Actually drain. Drain errors are internal (DB, repo remote lookup,
    //    payload schema drift) — log with detail, respond with a generic 500.
    let drain_result =
        match agent_actions_drain::drain_pending(deployment.config(), pool, task_id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(
                    task_id = %task_id,
                    worker_id = %worker_id,
                    "retry-actions drain failed: {}",
                    e
                );
                return Ok((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ResponseJson(ApiResponse::<RetryActionsResponse>::error(
                        "agent actions drain failed",
                    )),
                )
                    .into_response());
            }
        };

    // 6. Definitive failures during the drain must flip the task to `failed`
    //    with the same shape `on_agent_finished` uses (first failed row →
    //    failure_reason) so the board tells one story regardless of whether
    //    the drain ran from the finish hook or from here.
    if drain_result.failed > 0 {
        let rows = AgentAction::find_by_task_id(pool, task_id).await?;
        let first_failed = rows
            .iter()
            .find(|r| r.status == agent_action::STATUS_FAILED);
        let reason = match first_failed {
            Some(f) => format!(
                "agent action seq={} kind={} failed: {}",
                f.seq,
                f.kind,
                f.last_error.as_deref().unwrap_or("<sin detalle>")
            ),
            None => "agent action falló durante el drenaje".to_string(),
        };
        WorkerTask::set_failed(pool, task_id, &reason).await?;
    }

    Ok(ResponseJson(ApiResponse::<RetryActionsResponse>::success(
        RetryActionsResponse {
            done: drain_result.done,
            failed: drain_result.failed,
            pending_remaining: drain_result.pending_remaining,
        },
    ))
    .into_response())
}

/// HTML artifacts a designer task committed under `design/`, as repo-relative
/// paths the client turns into
/// `/api/workers/{w}/tasks/{t}/design-artifacts/{path}` links.
#[derive(Debug, Serialize, TS)]
pub struct DesignArtifactsResponse {
    pub files: Vec<String>,
}

/// GET /api/workers/{worker_id}/tasks/{task_id}/design-artifacts — list the
/// HTML files of a designer deliverable. Read from git refs, NOT the
/// worktree, so it works for archived workspaces too.
pub async fn list_design_artifacts(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<ApiResponse<DesignArtifactsResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;
    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }
    let repo = Repo::find_by_id(pool, existing.repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repo not found".into()))?;

    let git = deployment.container().git();
    let files = design_artifacts::list_artifacts(pool, git, &repo, &existing)
        .await?
        .map(|(_oid, files)| files)
        .unwrap_or_default();

    Ok(ResponseJson(ApiResponse::success(
        DesignArtifactsResponse { files },
    )))
}

/// Same browser sandbox as the workspace preview: inline scripts may run,
/// but the document gets an opaque origin — it cannot call the API or read
/// app storage.
const DESIGN_ARTIFACT_CSP: &str = "sandbox allow-scripts allow-forms allow-popups allow-modals";

/// GET /api/workers/{worker_id}/tasks/{task_id}/design-artifacts/{*path} —
/// serve one design artifact rendered, read straight from the git blob
/// (workspace branch → pushed `origin/design/*` ref). Unlike the workspace
/// preview this needs no worktree at all, so it works long after the
/// workspace is archived.
pub async fn serve_design_artifact(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id, path)): Path<(Uuid, Uuid, String)>,
) -> Result<Response, ApiError> {
    if !design_artifacts::is_design_artifact_path(&path) {
        return Err(ApiError::BadRequest("Not a design artifact path".into()));
    }
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;
    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }
    let repo = Repo::find_by_id(pool, existing.repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repo not found".into()))?;

    let git = deployment.container().git();
    if let Some(content) = design_artifacts::read_artifact(pool, git, &repo, &existing, &path).await?
    {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", DESIGN_ARTIFACT_CSP)
            .body(content.into())
            .map_err(|e| ApiError::BadRequest(format!("Response build error: {e}")));
    }
    Err(ApiError::BadRequest("Design artifact not found".into()))
}

/// POST /api/workers/{worker_id}/tasks/{task_id}/approve-design — the manual
/// gate that moves a designer task from `in_review` to `done`. Designer
/// deliverables never auto-complete: the user must see the artifact (and
/// possibly request follow-ups in the still-alive workspace) before giving
/// the final OK here.
pub async fn approve_design_task(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }

    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;
    if worker.role != ROLE_DESIGNER {
        return Err(ApiError::BadRequest(
            "Only designer tasks can be approved".into(),
        ));
    }
    if existing.status != worker_task::STATUS_IN_REVIEW {
        return Err(ApiError::Conflict(
            "Only designs awaiting review can be approved".into(),
        ));
    }

    let task = worker_orchestrator::approve_designer_task(
        deployment.config(),
        deployment.db(),
        deployment.container(),
        task_id,
    )
    .await?;

    let response = worker_task_to_response(pool, task).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Manually dispatch a new reviewer round for a developer task in `in_review`
/// with a verdict already on file. Two flavours:
/// - `changes_requested`: rescue path for when the automatic `pr_monitor` loop
///   failed to detect the author's fix push (or when the PM simply wants to
///   re-run the review sooner).
/// - `approved`: explicit human override after a follow-up on an approved task
///   (issue #471). The automatic loop stops re-reviewing once approved, so
///   this endpoint is the only way to ask for a fresh verdict on the new
///   commits without waiting for the reviewer to notice.
///
/// Returns an error code as the message so the UI can localize; the underlying
/// dispatch re-checks the same guards for safety.
pub async fn re_request_review(
    State(deployment): State<DeploymentImpl>,
    Path((worker_id, task_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    let existing = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker task not found".into()))?;

    if existing.worker_id != worker_id {
        return Err(ApiError::BadRequest(
            "Worker task does not belong to this worker".into(),
        ));
    }

    // Both in_review and approved statuses accept a manual re-review: a
    // changes_requested task sits on in_review, while an approved task with
    // the auto-transition lands on approved — same PR-still-open shape.
    if (existing.status != worker_task::STATUS_IN_REVIEW
        && existing.status != worker_task::STATUS_APPROVED)
        || !matches!(
            existing.review_result.as_deref(),
            Some("changes_requested") | Some("approved")
        )
    {
        return Err(ApiError::Conflict("no_verdict_to_rerun".into()));
    }

    // A review task must be tied to a PR (issue_number stores the PR number).
    let Some(pr_number) = existing.issue_number else {
        return Err(ApiError::BadRequest("no_open_pr".into()));
    };

    // The PR must still be open — reviewing a merged/closed PR is nonsense.
    let workspace_id = existing
        .workspace_id
        .ok_or_else(|| ApiError::BadRequest("no_open_pr".into()))?;
    let prs = PullRequest::find_by_workspace_id(pool, workspace_id).await?;
    let open_pr = prs
        .iter()
        .find(|pr| pr.pr_number == pr_number && matches!(pr.pr_status, MergeStatus::Open))
        .ok_or_else(|| ApiError::BadRequest("no_open_pr".into()))?;

    // Freshness gate: a re-review on an unchanged head can only reproduce the
    // previous verdict — the reviewer sees byte-identical code — while still
    // burning a review round. Surface a dedicated code so the UI can say
    // "push a fix first". Best-effort: an error while checking freshness must
    // not block a manual action, so it falls through to dispatch.
    if let Ok(host) = GitHostService::from_url(&open_pr.pr_url)
        && let Ok(Some(review)) = host.get_pr_latest_review(&open_pr.pr_url).await
        && let (Some(reviewed), Some(head)) = (&review.reviewed_sha, &review.head_sha)
        && reviewed == head
    {
        return Err(ApiError::Conflict("pr_head_unchanged".into()));
    }

    // Without a reviewer worker configured there is nowhere to dispatch the
    // task to. Also block the case where the only reviewer is the PR author
    // itself — GitHub rejects self-approval, so dispatch_review_task no-ops
    // and would leave the UI thinking it succeeded. Surface as 400 with a
    // clear "no reviewer" message either way.
    let reviewer = Worker::find_first_reviewer(pool)
        .await?
        .ok_or_else(|| ApiError::BadRequest("no_reviewer_assigned".into()))?;
    if reviewer.id == existing.worker_id {
        return Err(ApiError::BadRequest("no_reviewer_assigned".into()));
    }

    // Idempotency guard against double-click: dispatch_review_task also has
    // this guard, but it silently returns Ok(()), which would mislead the UI
    // into showing success without any dispatch happening.
    if WorkerTask::find_active_reviewer_task_for_pr(pool, pr_number, existing.repo_id)
        .await?
        .is_some()
    {
        return Err(ApiError::Conflict("review_already_in_progress".into()));
    }

    // Enforce max_review_rounds ourselves so we can return 409 with a clear
    // reason. dispatch_review_task's own cap check is a no-op logger, which
    // would otherwise let the user think the dispatch worked. Cap is
    // measured against the review_rounds ledger (spec §A5): only rounds
    // whose verdict was actually submitted to GitHub burn budget.
    let max_rounds = {
        let cfg = deployment.config().read().await;
        worker_orchestrator::resolve_max_review_rounds(&cfg)
    };
    let rounds = ReviewRound::count_submitted_for_pr(pool, existing.repo_id, pr_number).await?;
    if rounds >= max_rounds {
        return Err(ApiError::Conflict("max_review_rounds_reached".into()));
    }

    worker_orchestrator::dispatch_review_task(
        deployment.config(),
        deployment.db(),
        deployment.container(),
        pr_number,
        &existing.title,
        existing.repo_id,
        Some(existing.worker_id),
        // Explicit human retry: skip the automatic infra-failure backoff.
        true,
    )
    .await?;

    // Clear the stale verdict on the developer task so the card flips back to
    // the "awaiting review" pulse until the new reviewer round posts a verdict.
    WorkerTask::set_review_result(pool, task_id, None).await?;

    // If the task had already transitioned to `approved` (issue #464), a
    // manual re-review has to bring it back to `in_review` — otherwise the
    // loop badges and the "approved" chip would keep showing while a fresh
    // reviewer round is in flight. Skipped when the task is still in_review.
    if existing.status == worker_task::STATUS_APPROVED {
        WorkerTask::set_status(pool, task_id, worker_task::STATUS_IN_REVIEW).await?;
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// A worker task that reached a terminal status, for "done today" stats and
/// the dashboard activity feed.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct CompletedWorkerTask {
    /// Task UUID. Exposed so callers can PATCH the task (e.g. to set a
    /// per-task `hours_saved_override` from the value-generated panel).
    pub id: Uuid,
    pub worker_id: Uuid,
    pub title: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    /// "done" | "failed"
    pub status: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub completed_at: String,
    /// Per-task man-hours override (`NULL` = use the installation default).
    /// Kept on the response so the value-generated panel can render the
    /// current value inline without a second round-trip per task.
    pub hours_saved_override: Option<f64>,
}

#[derive(Debug, Serialize, TS)]
pub struct CompletedWorkerTasksResponse {
    pub tasks: Vec<CompletedWorkerTask>,
}

#[derive(Debug, Deserialize)]
pub struct CompletedTasksQuery {
    /// Lower bound (inclusive) as an ISO-8601 / RFC-3339 timestamp.
    pub since: String,
}

/// Worker tasks completed at or after `since`, newest first.
///
/// `completed_at` is intentionally read with a runtime-checked query (and kept
/// out of the `WorkerTask` model) so the committed sqlx offline metadata for
/// the macro queries stays valid.
pub async fn list_completed_worker_tasks(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<CompletedTasksQuery>,
) -> Result<ResponseJson<ApiResponse<CompletedWorkerTasksResponse>>, ApiError> {
    let tasks: Vec<CompletedWorkerTask> = sqlx::query_as(
        "SELECT id, worker_id, title, issue_number, status, completed_at,
                hours_saved_override
         FROM worker_tasks
         WHERE completed_at IS NOT NULL AND completed_at >= datetime($1)
         ORDER BY completed_at DESC
         LIMIT 200",
    )
    .bind(&query.since)
    .fetch_all(&deployment.db().pool)
    .await?;

    Ok(ResponseJson(ApiResponse::success(
        CompletedWorkerTasksResponse { tasks },
    )))
}

/// Body for `POST /api/workers/validate-github-pat` — a lightweight probe
/// used by the form to confirm a token is accepted before saving. The token
/// is not stored anywhere.
#[derive(Debug, Deserialize, TS)]
pub struct ValidateGithubPatRequest {
    pub token: String,
}

#[derive(Debug, Serialize, TS)]
pub struct ValidateGithubPatResponse {
    /// GitHub login for the token owner (e.g. "chewax"), so the UI can
    /// confirm to the user which identity the PAT belongs to.
    pub login: String,
}

pub async fn validate_github_pat_endpoint(
    Json(payload): Json<ValidateGithubPatRequest>,
) -> Result<ResponseJson<ApiResponse<ValidateGithubPatResponse>>, ApiError> {
    let token = payload.token.trim().to_string();
    if token.is_empty() {
        return Err(ApiError::BadRequest("token is required".into()));
    }
    match validate_github_pat(token).await {
        Ok(login) => Ok(ResponseJson(ApiResponse::success(
            ValidateGithubPatResponse { login },
        ))),
        Err(reason) => Err(ApiError::BadRequest(format!(
            "GitHub PAT rejected: {reason}"
        ))),
    }
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/workers", get(list_workers).post(create_worker))
        .route("/workers/start-all", post(start_all_workers))
        .route("/workers/active-issue-task", get(get_active_issue_task))
        .route("/workers/design-handoffs", post(create_design_handoff))
        .route(
            "/workers/design-handoffs/pending",
            get(list_pending_design_handoffs),
        )
        .route("/workers/completed-tasks", get(list_completed_worker_tasks))
        .route("/workers/failed-tasks", delete(delete_all_failed_tasks))
        .route(
            "/workers/archived",
            get(list_archived_workers).delete(delete_all_archived_workers),
        )
        .route(
            "/workers/validate-github-pat",
            post(validate_github_pat_endpoint),
        )
        .route(
            "/workers/{worker_id}",
            get(get_worker).patch(update_worker).delete(delete_worker),
        )
        .route("/workers/{worker_id}/start", post(start_worker))
        .route("/workers/{worker_id}/duplicate", post(duplicate_worker))
        .route("/workers/{worker_id}/archive", post(archive_worker))
        .route("/workers/{worker_id}/unarchive", post(unarchive_worker))
        .route(
            "/workers/{worker_id}/tasks",
            get(list_worker_tasks).post(create_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}",
            axum::routing::patch(update_worker_task).delete(delete_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/cancel",
            post(cancel_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/approve-design",
            post(approve_design_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/design-artifacts",
            get(list_design_artifacts),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/design-artifacts/{*path}",
            get(serve_design_artifact),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/reassign",
            post(reassign_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/re-request-review",
            post(re_request_review),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/retry-actions",
            post(retry_worker_task_actions),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PATCH must distinguish three states for `model`:
    ///   missing → `None`         (don't touch)
    ///   `null`  → `Some(None)`   (clear the override)
    ///   string  → `Some(Some(_))`(set the override)
    /// The default serde behavior collapses the first two into `None`, which
    /// makes "clear" impossible; the custom deserializer restores the third
    /// state.
    #[test]
    fn update_worker_request_model_distinguishes_missing_from_null() {
        let missing: UpdateWorkerRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.model, None);

        let null: UpdateWorkerRequest = serde_json::from_str(r#"{"model": null}"#).unwrap();
        assert_eq!(null.model, Some(None));

        let set: UpdateWorkerRequest = serde_json::from_str(r#"{"model": "haiku"}"#).unwrap();
        assert_eq!(set.model, Some(Some("haiku".to_string())));
    }

    /// The same three-state contract must apply to `github_pat` — missing
    /// means "don't touch the stored PAT", `null` means "clear it and fall
    /// back to global gh auth", and a string means "replace with this value".
    #[test]
    fn update_worker_request_github_pat_distinguishes_missing_from_null() {
        let missing: UpdateWorkerRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.github_pat, None);

        let null: UpdateWorkerRequest = serde_json::from_str(r#"{"github_pat": null}"#).unwrap();
        assert_eq!(null.github_pat, Some(None));

        let set: UpdateWorkerRequest =
            serde_json::from_str(r#"{"github_pat": "ghp_abc"}"#).unwrap();
        assert_eq!(set.github_pat, Some(Some("ghp_abc".to_string())));
    }

    /// `hours_saved_override` also needs the three-state distinction: missing
    /// means "keep whatever is stored", `null` clears the override back to the
    /// installation default, and a number persists the value for this task.
    #[test]
    fn update_worker_task_request_hours_override_distinguishes_missing_from_null() {
        let missing: UpdateWorkerTaskRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.hours_saved_override, None);

        let null: UpdateWorkerTaskRequest =
            serde_json::from_str(r#"{"hours_saved_override": null}"#).unwrap();
        assert_eq!(null.hours_saved_override, Some(None));

        let set: UpdateWorkerTaskRequest =
            serde_json::from_str(r#"{"hours_saved_override": 6.5}"#).unwrap();
        assert_eq!(set.hours_saved_override, Some(Some(6.5)));
    }

    /// `plan_mode` also needs the three-state distinction: missing means
    /// "keep whatever is stored", `null` clears the override so the worker
    /// follows the global setting again, and a boolean explicitly forces
    /// plan mode on or off for the worker.
    #[test]
    fn update_worker_request_plan_mode_distinguishes_missing_from_null() {
        let missing: UpdateWorkerRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.plan_mode, None);

        let null: UpdateWorkerRequest = serde_json::from_str(r#"{"plan_mode": null}"#).unwrap();
        assert_eq!(null.plan_mode, Some(None));

        let on: UpdateWorkerRequest = serde_json::from_str(r#"{"plan_mode": true}"#).unwrap();
        assert_eq!(on.plan_mode, Some(Some(true)));

        let off: UpdateWorkerRequest = serde_json::from_str(r#"{"plan_mode": false}"#).unwrap();
        assert_eq!(off.plan_mode, Some(Some(false)));
    }
}
