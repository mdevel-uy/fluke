//! Director (en la UI, "Fluke"): misiones, traspaso al Analista (G1) y el MCP
//! que usa el agente (`/director-mcp/{session_id}`).

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{get, post},
};
use db::models::{
    mission::{self, AUTONOMY_VALUES, Mission},
    session::{CreateSession, Session},
    worker::{ROLE_ANALYST, Worker},
    worker_task::{CreateWorkerTask, SOURCE_DESK, WorkerTask},
    workspace::{Workspace, WorkspaceContext},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::{
    director::{self, MissionDetail},
    worker_orchestrator,
};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, routes::workspaces::scratch};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/director-mcp/{session_id}", post(mcp).get(mcp_get))
        .route("/missions", get(list_missions).post(create_mission))
        .route("/missions/{id}", get(get_mission).patch(update_mission))
        .route("/missions/{id}/approve", post(approve_brief))
        .route("/missions/{id}/workspace", get(get_mission_workspace))
}

// ---------------------------------------------------------------------------
// Misiones
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
pub struct MissionSummary {
    pub mission: Mission,
    pub repo_name: Option<String>,
    pub agent_running: bool,
    #[ts(type = "number")]
    pub issues_total: i64,
    #[ts(type = "number")]
    pub issues_closed: i64,
}

async fn list_missions(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<MissionSummary>>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut out = Vec::new();
    for mission in Mission::list(pool).await? {
        let repo_name = match mission.repo_id {
            Some(id) => db::models::repo::Repo::find_by_id(pool, id)
                .await?
                .map(|r| r.display_name),
            None => None,
        };
        let (issues_total, issues_closed) = Mission::issue_progress(pool, mission.id).await?;
        out.push(MissionSummary {
            agent_running: Mission::agent_running(pool, mission.id).await?,
            mission,
            repo_name,
            issues_total,
            issues_closed,
        });
    }
    Ok(ResponseJson(ApiResponse::success(out)))
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateMissionRequest {
    /// Repo activo en la app: la sesión corre en su worktree scratch y es el
    /// repo inicial de la misión (el agente puede cambiarlo).
    pub repo_id: Uuid,
}

async fn create_mission(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateMissionRequest>,
) -> Result<ResponseJson<ApiResponse<MissionDetail>>, ApiError> {
    let pool = &deployment.db().pool;
    let worker = director::ensure_orchestrator(pool).await?;
    let executor_config = director::executor_config(&*deployment.config().read().await, &worker)
        .map_err(ApiError::BadRequest)?;

    let workspace = scratch::ensure_scratch_workspace(&deployment, payload.repo_id).await?;
    let session = Session::create(
        pool,
        &CreateSession {
            executor: Some(executor_config.executor.to_string()),
            name: Some("Fluke".to_string()),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await?;
    let mission = Mission::create(pool, session.id, Some(payload.repo_id)).await?;
    Ok(ResponseJson(ApiResponse::success(
        director::detail(pool, mission).await?,
    )))
}

async fn load(deployment: &DeploymentImpl, id: Uuid) -> Result<Mission, ApiError> {
    Mission::find_by_id(&deployment.db().pool, id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Mission not found".into()))
}

async fn get_mission(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<MissionDetail>>, ApiError> {
    let mission = load(&deployment, id).await?;
    Ok(ResponseJson(ApiResponse::success(
        director::detail(&deployment.db().pool, mission).await?,
    )))
}

#[derive(Debug, Deserialize, TS)]
pub struct UpdateMissionRequest {
    pub title: Option<String>,
    pub autonomy: Option<String>,
    /// Dónde está el user en la app; va en el system prompt de cada turno.
    pub ui_context: Option<String>,
    /// `true` cierra la misión.
    pub close: Option<bool>,
}

async fn update_mission(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateMissionRequest>,
) -> Result<ResponseJson<ApiResponse<MissionDetail>>, ApiError> {
    let pool = &deployment.db().pool;
    load(&deployment, id).await?;
    if let Some(title) = &payload.title {
        Mission::set_title(pool, id, title.trim()).await?;
    }
    if let Some(autonomy) = &payload.autonomy {
        if !AUTONOMY_VALUES.contains(&autonomy.as_str()) {
            return Err(ApiError::BadRequest(format!(
                "autonomy must be one of {AUTONOMY_VALUES:?}"
            )));
        }
        Mission::set_autonomy(pool, id, autonomy).await?;
    }
    if let Some(ctx) = &payload.ui_context {
        Mission::set_ui_context(pool, id, Some(ctx.as_str())).await?;
    }
    if payload.close == Some(true) {
        Mission::set_status(pool, id, mission::STATUS_CLOSED).await?;
    }
    Ok(ResponseJson(ApiResponse::success(
        director::refresh_status(pool, id).await?,
    )))
}

#[derive(Debug, Deserialize, TS)]
pub struct ApproveBriefRequest {
    /// Analista que recibe la request; sin él, el primero del equipo.
    pub analyst_worker_id: Option<Uuid>,
}

/// G1: el user aprueba el brief. Se guarda una versión y se manda al Analyst
/// Desk como una request normal (tarea `source = desk` del analista).
async fn approve_brief(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(payload): Json<ApproveBriefRequest>,
) -> Result<ResponseJson<ApiResponse<MissionDetail>>, ApiError> {
    let pool = &deployment.db().pool;
    load(&deployment, id).await?;
    let d = director::refresh_status(pool, id).await?;
    if d.mission.status != mission::STATUS_BRIEF_READY || !d.complete {
        return Err(ApiError::Conflict(
            "The brief is not complete yet".to_string(),
        ));
    }
    let repo_id = d.mission.repo_id.expect("complete brief has a repo");

    let analysts: Vec<Worker> = Worker::list_all(pool)
        .await?
        .into_iter()
        .filter(|w| w.role == ROLE_ANALYST)
        .collect();
    let analyst = match payload.analyst_worker_id {
        Some(wid) => analysts.into_iter().find(|w| w.id == wid),
        None => analysts.into_iter().next(),
    }
    .ok_or_else(|| {
        ApiError::BadRequest("There is no Analyst worker to send the brief to".into())
    })?;

    let markdown = director::render_markdown(&d);
    let version = Mission::add_brief_version(pool, id, &markdown).await?;
    let task = WorkerTask::append(
        pool,
        analyst.id,
        &CreateWorkerTask {
            repo_id,
            title: d.mission.title.chars().take(80).collect(),
            prompt: director::analyst_request_prompt(&d, version),
            source: SOURCE_DESK.to_string(),
            ..Default::default()
        },
    )
    .await?;
    Mission::set_analyst_task(pool, id, task.id).await?;
    Mission::set_status(pool, id, mission::STATUS_PLANNING).await?;

    // Igual que el Analyst Desk: si el analista está libre arranca ya; si no,
    // la request queda en su cola.
    if let Err(e) = worker_orchestrator::try_take_next(
        deployment.config(),
        deployment.db(),
        deployment.container(),
        analyst.id,
    )
    .await
        && !e.is_conflict()
    {
        tracing::warn!(mission_id = %id, "brief sent but the analyst did not start: {e}");
    }

    Ok(ResponseJson(ApiResponse::success(
        director::refresh_status(pool, id).await?,
    )))
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC por POST, transporte "streamable HTTP" sin sesión)
// ---------------------------------------------------------------------------

async fn mcp_get() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn mcp(
    State(deployment): State<DeploymentImpl>,
    Path(session_id): Path<Uuid>,
    Json(msg): Json<Value>,
) -> Response {
    let Some(id) = msg.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params
                .get("protocolVersion")
                .cloned()
                .unwrap_or_else(|| json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fluke_director", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Record the user's request as a structured brief with these tools."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": director::tool_definitions() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let out = director::call_tool(&deployment.db().pool, session_id, name, &args).await;
            Ok(match out {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(text) => {
                    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
                }
            })
        }
        other => Err(json!({ "code": -32601, "message": format!("method not found: {other}") })),
    };
    let body = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    };
    Json(body).into_response()
}

/// Workspace donde corre la sesión de la misión (lo necesita el chat).
async fn get_mission_workspace(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<WorkspaceContext>>, ApiError> {
    let mission = load(&deployment, id).await?;
    let ctx = Workspace::load_context(&deployment.db().pool, mission.workspace_id).await?;
    Ok(ResponseJson(ApiResponse::success(ctx)))
}
