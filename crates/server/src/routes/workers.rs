use axum::{
    Json, Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use db::models::{
    merge::MergeStatus,
    pull_request::PullRequest,
    worker::{CreateWorker, UpdateWorker, Worker},
    worker_task::{self, CreateWorkerTask, WorkerTask},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::worker_orchestrator::{self, StartError};
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
    /// URL of the most recent pull request tracked for this task's workspace,
    /// or `null` when no PR has been created yet.
    pub pr_url: Option<String>,
    /// State of the most recent PR: `"open" | "merged" | "closed"`, or
    /// `null` when there is no tracked PR.
    pub pr_state: Option<String>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}

async fn worker_task_to_response(
    pool: &sqlx::SqlitePool,
    task: WorkerTask,
) -> Result<WorkerTaskResponse, ApiError> {
    let (pr_url, pr_state) = match task.workspace_id {
        Some(workspace_id) => {
            let prs = PullRequest::find_by_workspace_id(pool, workspace_id).await?;
            match prs.into_iter().next() {
                Some(pr) => (Some(pr.pr_url), Some(merge_status_str(&pr.pr_status))),
                None => (None, None),
            }
        }
        None => (None, None),
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
        pr_url,
        pr_state,
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
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateWorkerRequest {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub soul: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkerTaskRequest {
    pub repo_id: Uuid,
    pub title: String,
    pub prompt: String,
    #[ts(type = "number | null", optional)]
    pub issue_number: Option<i64>,
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateWorkerTaskRequest {
    #[ts(type = "number | null", optional)]
    pub position: Option<i64>,
    #[ts(optional)]
    pub status: Option<String>,
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
        active_workspace_id,
        queued_count,
        completed_count,
        created_at: worker.created_at,
    })
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

    let pool = &deployment.db().pool;
    let worker = Worker::create(
        pool,
        &CreateWorker {
            name: name.to_string(),
            emoji: emoji.to_string(),
            soul: payload.soul,
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

    Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Worker not found".into()))?;

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
        },
    )
    .await?;

    let response = to_response(pool, worker).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
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

    let task = WorkerTask::append(
        pool,
        worker_id,
        &CreateWorkerTask {
            repo_id: payload.repo_id,
            title: title.to_string(),
            prompt: prompt.to_string(),
            issue_number: payload.issue_number,
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
    if existing.status != worker_task::STATUS_QUEUED {
        return Err(ApiError::Conflict(
            "Only queued tasks can be deleted".into(),
        ));
    }

    WorkerTask::delete(pool, task_id).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/workers", get(list_workers).post(create_worker))
        .route("/workers/start-all", post(start_all_workers))
        .route(
            "/workers/{worker_id}",
            get(get_worker).patch(update_worker).delete(delete_worker),
        )
        .route("/workers/{worker_id}/start", post(start_worker))
        .route(
            "/workers/{worker_id}/tasks",
            get(list_worker_tasks).post(create_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}",
            axum::routing::patch(update_worker_task).delete(delete_worker_task),
        )
}
