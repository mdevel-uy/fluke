//! Plan de trabajo del agente: el MCP que usa el agente (`/plan-mcp/{id}`),
//! el snapshot + stream que usa el grafo, y los controles de ejecución.

use axum::{
    Json, Router,
    extract::{Path, State, ws::Message},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson, Response},
    routing::{get, post},
};
use db::models::plan::{Plan, PlanSnapshot};
use deployment::Deployment;
use futures_util::{StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use services::services::plan as plan_service;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/plan-mcp/{workspace_id}", post(mcp).get(mcp_get))
        .route("/plan/{workspace_id}", get(get_plan))
        .route("/plan/{workspace_id}/stream/ws", get(stream_ws))
        .route("/plan/{workspace_id}/pause", post(pause))
        .route("/plan/{workspace_id}/stop", post(stop))
        .route("/plan/{workspace_id}/play", post(play))
        .route("/plan/{workspace_id}/question", get(get_question))
        .route("/plan/{workspace_id}/answer", post(answer))
        .route("/plan/{workspace_id}/steps/{n}/revert", post(revert))
        .route("/plan/{workspace_id}/steps/{n}/cut", post(cut))
        .route(
            "/plan/{workspace_id}/steps/{n}/revisions",
            post(request_revision),
        )
        .route(
            "/plan/revisions/{revision_id}/accept",
            post(accept_revision),
        )
        .route(
            "/plan/revisions/{revision_id}/discard",
            post(discard_revision),
        )
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC por POST, transporte "streamable HTTP" sin sesión)
// ---------------------------------------------------------------------------

async fn mcp_get() -> StatusCode {
    // Sin stream de notificaciones servidor → cliente.
    StatusCode::METHOD_NOT_ALLOWED
}

async fn mcp(
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
    Json(msg): Json<Value>,
) -> Response {
    let Some(id) = msg.get("id").cloned() else {
        // Notificación (ej. notifications/initialized): sin respuesta.
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
            "serverInfo": { "name": "fluke_plan", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Declare your plan with submit_plan before editing files, then wrap each step in start_step / complete_step."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": plan_service::tool_definitions() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let out = plan_service::call_tool(
                &deployment.db().pool,
                deployment.events().msg_store(),
                workspace_id,
                name,
                &args,
            )
            .await;
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

// ---------------------------------------------------------------------------
// Snapshot y stream
// ---------------------------------------------------------------------------

async fn get_plan(
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Option<PlanSnapshot>>>, ApiError> {
    let snap = Plan::snapshot(&deployment.db().pool, workspace_id).await?;
    Ok(ResponseJson(ApiResponse::success(snap)))
}

async fn stream_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_ws(socket, deployment, workspace_id).await {
            tracing::warn!("plan WS closed: {}", e);
        }
    })
}

async fn handle_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    workspace_id: Uuid,
) -> anyhow::Result<()> {
    let mut stream = plan_service::stream_raw(
        &deployment.db().pool,
        deployment.events().msg_store().clone(),
        workspace_id,
    )
    .await?
    .map_ok(|msg| msg.to_ws_message_unchecked());
    loop {
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(msg)) => if socket.send(msg).await.is_err() { break },
                Some(Err(e)) => { tracing::error!("plan stream error: {}", e); break }
                None => break,
            },
            inbound = socket.recv() => match inbound {
                Ok(Some(Message::Close(_))) | Ok(None) | Err(_) => break,
                Ok(Some(_)) => {}
            },
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

type Empty = Result<ResponseJson<ApiResponse<()>>, ApiError>;

fn ok() -> ResponseJson<ApiResponse<()>> {
    ResponseJson(ApiResponse::success(()))
}

#[derive(Debug, Deserialize, TS)]
pub struct PlanPauseRequest {
    pub on: bool,
}

async fn pause(
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
    Json(req): Json<PlanPauseRequest>,
) -> Empty {
    plan_service::set_pause(
        &deployment.db().pool,
        deployment.events().msg_store(),
        workspace_id,
        req.on,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

async fn stop(State(deployment): State<DeploymentImpl>, Path(workspace_id): Path<Uuid>) -> Empty {
    plan_service::stop(
        &deployment.db().pool,
        deployment.events().msg_store(),
        deployment.container(),
        workspace_id,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

async fn play(State(deployment): State<DeploymentImpl>, Path(workspace_id): Path<Uuid>) -> Empty {
    plan_service::play(
        &deployment.db().pool,
        deployment.events().msg_store(),
        deployment.container(),
        workspace_id,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

async fn revert(
    State(deployment): State<DeploymentImpl>,
    Path((workspace_id, n)): Path<(Uuid, i64)>,
) -> Empty {
    plan_service::revert_to_step(
        &deployment.db().pool,
        deployment.events().msg_store(),
        deployment.container(),
        workspace_id,
        n,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

#[derive(Debug, Deserialize, TS)]
pub struct PlanCutRequest {
    pub cut: bool,
}

async fn cut(
    State(deployment): State<DeploymentImpl>,
    Path((workspace_id, n)): Path<(Uuid, i64)>,
    Json(req): Json<PlanCutRequest>,
) -> Empty {
    plan_service::set_step_cut(
        &deployment.db().pool,
        deployment.events().msg_store(),
        workspace_id,
        n,
        req.cut,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

#[derive(Debug, Deserialize, TS)]
pub struct PlanRevisionRequest {
    pub request: String,
}

async fn request_revision(
    State(deployment): State<DeploymentImpl>,
    Path((workspace_id, n)): Path<(Uuid, i64)>,
    Json(req): Json<PlanRevisionRequest>,
) -> Result<ResponseJson<ApiResponse<Uuid>>, ApiError> {
    let text = req.request.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::BadRequest("empty request".into()));
    }
    let id = plan_service::request_revision(
        &deployment.db().pool,
        deployment.events().msg_store().clone(),
        workspace_id,
        n,
        text,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ResponseJson(ApiResponse::success(id)))
}

async fn accept_revision(
    State(deployment): State<DeploymentImpl>,
    Path(revision_id): Path<Uuid>,
) -> Empty {
    plan_service::accept_revision(
        &deployment.db().pool,
        deployment.events().msg_store(),
        deployment.container(),
        revision_id,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

async fn discard_revision(
    State(deployment): State<DeploymentImpl>,
    Path(revision_id): Path<Uuid>,
) -> Empty {
    plan_service::discard_revision(
        &deployment.db().pool,
        deployment.events().msg_store(),
        revision_id,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}

/// Pregunta de `ask_user` que espera respuesta (o `null`).
async fn get_question(
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Option<Value>>>, ApiError> {
    let q = plan_service::pending_question(&deployment.db().pool, workspace_id)
        .await
        .map_err(ApiError::Conflict)?;
    Ok(ResponseJson(ApiResponse::success(q)))
}

#[derive(Debug, Deserialize)]
pub struct PlanAnswerRequest {
    /// La pregunta que se responde: los argumentos de esa llamada a `ask_user`.
    /// Si ya no es la pendiente (respondida o reemplazada) se responde 409.
    pub question: Value,
    /// Clave de una opción de la pregunta o una respuesta libre.
    pub answer: String,
}

/// Respuesta a la pregunta pendiente de `ask_user`.
async fn answer(
    State(deployment): State<DeploymentImpl>,
    Path(workspace_id): Path<Uuid>,
    Json(req): Json<PlanAnswerRequest>,
) -> Empty {
    plan_service::answer_question(
        &deployment.db().pool,
        deployment.container(),
        workspace_id,
        &req.question,
        &req.answer,
    )
    .await
    .map_err(ApiError::Conflict)?;
    Ok(ok())
}
