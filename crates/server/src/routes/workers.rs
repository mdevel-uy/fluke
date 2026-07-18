use axum::{
    Json, Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::get,
};
use chrono::{DateTime, Utc};
use db::models::{
    worker::{CreateWorker, UpdateWorker, Worker},
    worker_task::{self, CreateWorkerTask, WorkerTask},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
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
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}

impl From<WorkerTask> for WorkerTaskResponse {
    fn from(t: WorkerTask) -> Self {
        Self {
            id: t.id,
            worker_id: t.worker_id,
            repo_id: t.repo_id,
            position: t.position,
            title: t.title,
            prompt: t.prompt,
            issue_number: t.issue_number,
            status: t.status,
            workspace_id: t.workspace_id,
            created_at: t.created_at,
        }
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

async fn to_response(
    pool: &sqlx::SqlitePool,
    worker: Worker,
) -> Result<WorkerResponse, ApiError> {
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
            name: payload.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            emoji: payload.emoji.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
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
    let response: Vec<WorkerTaskResponse> = tasks.into_iter().map(Into::into).collect();
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
    deployment
        .repo()
        .get_by_id(pool, payload.repo_id)
        .await?;

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

    Ok(ResponseJson(ApiResponse::success(task.into())))
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

    let updated = WorkerTask::update(
        pool,
        task_id,
        payload.position,
        payload.status.as_deref(),
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(updated.into())))
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
        .route(
            "/workers/{worker_id}",
            get(get_worker).patch(update_worker).delete(delete_worker),
        )
        .route(
            "/workers/{worker_id}/tasks",
            get(list_worker_tasks).post(create_worker_task),
        )
        .route(
            "/workers/{worker_id}/tasks/{task_id}",
            axum::routing::patch(update_worker_task).delete(delete_worker_task),
        )
}
