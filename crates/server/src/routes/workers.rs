use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use db::models::{
    file::File,
    merge::MergeStatus,
    pull_request::PullRequest,
    worker::{CreateWorker, ROLE_ANALYST, ROLE_DEVELOPER, ROLE_REVIEWER, UpdateWorker, Worker},
    worker_task::{self, CreateWorkerTask, WorkerTask},
    workspace::Workspace,
};
use deployment::Deployment;
use git_host::github::GhCli;
use serde::{Deserialize, Deserializer, Serialize};
use services::services::{
    container::ContainerService,
    worker_orchestrator::{self, StartError},
};
use tokio::task;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

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
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}

async fn worker_task_to_response(
    pool: &sqlx::SqlitePool,
    task: WorkerTask,
) -> Result<WorkerTaskResponse, ApiError> {
    let (pr_url, pr_state, pr_mergeable) = match task.workspace_id {
        Some(workspace_id) => {
            let prs = PullRequest::find_by_workspace_id(pool, workspace_id).await?;
            match prs.into_iter().next() {
                Some(pr) => (
                    Some(pr.pr_url),
                    Some(merge_status_str(&pr.pr_status)),
                    pr.pr_mergeable,
                ),
                None => (None, None, None),
            }
        }
        None => (None, None, None),
    };

    let skills: Vec<String> = serde_json::from_str(&task.skills).unwrap_or_default();

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
        pr_url,
        pr_state,
        pr_mergeable,
        source: task.source,
        review_result: task.review_result,
        created_at: task.created_at,
    })
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
}

#[derive(Debug, Deserialize, TS)]
pub struct ReassignWorkerTaskRequest {
    pub target_worker_id: Uuid,
}

fn is_valid_role(role: &str) -> bool {
    matches!(role, ROLE_DEVELOPER | ROLE_ANALYST | ROLE_REVIEWER)
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
    if let Some(ref token) = github_pat {
        if let Err(reason) = validate_github_pat(token.clone()).await {
            return Err(ApiError::BadRequest(format!(
                "GitHub PAT rejected: {reason}"
            )));
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
    if let Some(Some(ref token)) = github_pat {
        if let Err(reason) = validate_github_pat(token.clone()).await {
            return Err(ApiError::BadRequest(format!(
                "GitHub PAT rejected: {reason}"
            )));
        }
    }

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

pub async fn create_worker_task(
    State(deployment): State<DeploymentImpl>,
    Path(worker_id): Path<Uuid>,
    Json(payload): Json<CreateWorkerTaskRequest>,
) -> Result<ResponseJson<ApiResponse<WorkerTaskResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    Worker::find_by_id(pool, worker_id)
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

    let task = WorkerTask::append(
        pool,
        worker_id,
        &CreateWorkerTask {
            repo_id: payload.repo_id,
            title: title.to_string(),
            prompt: final_prompt,
            issue_number: payload.issue_number,
            skills,
            source,
        },
    )
    .await?;

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

    let updated =
        WorkerTask::update(pool, task_id, payload.position, payload.status.as_deref()).await?;

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
/// run for it. Returns 409 when the worker is not currently eligible to
/// take a task (already in_progress, at the in_review cap, or nothing
/// queued).
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
            ApiError::Conflict(format!("Worker in-review cap reached ({cap})"))
        }
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

    WorkerTask::delete(pool, task_id).await?;
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
    Worker::find_by_id(pool, payload.target_worker_id)
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
    {
        return Err(ApiError::Conflict(
            "Only in_progress or in_review tasks can be cancelled".into(),
        ));
    }

    if let Some(workspace_id) = existing.workspace_id {
        if let Ok(Some(workspace)) = Workspace::find_by_id(pool, workspace_id).await {
            deployment.container().try_stop(&workspace, false).await;
        }
    }

    WorkerTask::delete(pool, task_id).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Manually dispatch a new reviewer round for a developer task that is stuck
/// in `in_review` with `review_result = 'changes_requested'`. Rescue path for
/// when the automatic `pr_monitor` loop failed to detect the author's fix push
/// (or when the PM simply wants to re-run the review sooner). Returns an
/// error code as the message so the UI can localize; the underlying dispatch
/// re-checks the same guards for safety.
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

    if existing.status != worker_task::STATUS_IN_REVIEW
        || existing.review_result.as_deref() != Some("changes_requested")
    {
        return Err(ApiError::Conflict("no_changes_requested".into()));
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
    let has_open_pr = prs
        .iter()
        .any(|pr| pr.pr_number == pr_number && pr.pr_status == MergeStatus::Open);
    if !has_open_pr {
        return Err(ApiError::BadRequest("no_open_pr".into()));
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
    // would otherwise let the user think the dispatch worked.
    let max_rounds = {
        let cfg = deployment.config().read().await;
        worker_orchestrator::resolve_max_review_rounds(&cfg)
    };
    let rounds =
        WorkerTask::count_reviewer_tasks_for_pr(pool, pr_number, existing.repo_id).await?;
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
    )
    .await?;

    // Clear the stale verdict on the developer task so the card flips back to
    // the "awaiting review" pulse until the new reviewer round posts a verdict.
    WorkerTask::set_review_result(pool, task_id, None).await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// A worker task that reached a terminal status, for "done today" stats and
/// the dashboard activity feed.
#[derive(Debug, Serialize, TS, sqlx::FromRow)]
pub struct CompletedWorkerTask {
    pub worker_id: Uuid,
    pub title: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    /// "done" | "failed"
    pub status: String,
    /// SQLite datetime string (UTC): "YYYY-MM-DD HH:MM:SS.SSS"
    pub completed_at: String,
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
        "SELECT worker_id, title, issue_number, status, completed_at
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
        .route("/workers/completed-tasks", get(list_completed_worker_tasks))
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
            "/workers/{worker_id}/tasks/{task_id}/reassign",
            post(reassign_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}/re-request-review",
            post(re_request_review),
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

        let null: UpdateWorkerRequest =
            serde_json::from_str(r#"{"github_pat": null}"#).unwrap();
        assert_eq!(null.github_pat, Some(None));

        let set: UpdateWorkerRequest =
            serde_json::from_str(r#"{"github_pat": "ghp_abc"}"#).unwrap();
        assert_eq!(set.github_pat, Some(Some("ghp_abc".to_string())));
    }
}
