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
    worker_task::{CreateWorkerTask, SOURCE_MISSION, WorkerTask},
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
        .route("/director/turn", post(director_turn))
        .route("/missions/{id}/approve", post(approve_brief))
        .route("/missions/{id}/focus", post(focus_mission))
        .route("/missions/{id}/turns", get(mission_turns))
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
    /// Issues the Analyst created for the mission.
    #[ts(type = "Array<number>")]
    pub issue_numbers: Vec<i64>,
    /// Fluke's standing conversation (J0.3): app events land here, no brief.
    pub is_guard: bool,
}

async fn list_missions(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<MissionSummary>>>, ApiError> {
    let pool = &deployment.db().pool;
    let guard = db::models::fluke_event::FlukeGuard::get(pool)
        .await?
        .map(|g| g.mission_id);
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
            is_guard: guard == Some(mission.id),
            issue_numbers: Mission::issue_numbers(pool, mission.id).await?,
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
    let mission = new_mission_in(&deployment, payload.repo_id).await?;
    Ok(ResponseJson(ApiResponse::success(
        director::detail(&deployment.db().pool, mission).await?,
    )))
}

/// A mission in a repo: its session runs in the repo's scratch worktree.
async fn new_mission_in(deployment: &DeploymentImpl, repo_id: Uuid) -> Result<Mission, ApiError> {
    let pool = &deployment.db().pool;
    let worker = director::ensure_orchestrator(pool).await?;
    let executor_config = director::executor_config(&*deployment.config().read().await, &worker)
        .map_err(ApiError::BadRequest)?;
    let workspace = scratch::ensure_scratch_workspace(deployment, repo_id).await?;
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
    Ok(Mission::create(pool, session.id, Some(repo_id)).await?)
}

/// `new_mission` from Fluke's standing conversation (J1.2): it needs the
/// scratch workspace, so it lives here and not in the services crate.
async fn new_mission_tool(deployment: &DeploymentImpl, session_id: Uuid, args: &Value) -> Result<String, String> {
    use db::models::fluke_event::FlukeGuard;
    let pool = &deployment.db().pool;
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    let mission = Mission::find_by_session_id(pool, session_id)
        .await
        .map_err(db_err)?
        .ok_or("this session has no mission")?;
    if !FlukeGuard::is_guard(pool, mission.id).await.map_err(db_err)? {
        return Err("new missions start from your standing conversation".into());
    }
    let repo = args
        .get("repo")
        .and_then(Value::as_str)
        .ok_or("missing repo")?;
    let repo = director::resolve_repo(pool, repo).await?;
    let created = new_mission_in(deployment, repo.id)
        .await
        .map_err(|e| format!("could not start the mission: {e}"))?;
    if let Some(title) = args.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
        Mission::set_title(pool, created.id, title).await.map_err(db_err)?;
    }
    FlukeGuard::set_focus(pool, Some(created.id)).await.map_err(db_err)?;
    let d = director::refresh_status(pool, created.id).await.map_err(db_err)?;
    Ok(format!(
        "Mission started and in focus (id {}). Missing: {}",
        created.id,
        d.missing.join(", ")
    ))
}

/// The user opened a mission (J1.2): what they write next is about it.
async fn focus_mission(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    load(&deployment, id).await?;
    let guard = db::models::fluke_event::FlukeGuard::get(pool).await?;
    // The standing conversation itself is not a focus.
    let focus = guard.filter(|g| g.mission_id != id).map(|_| id);
    if focus.is_some() {
        db::models::fluke_event::FlukeGuard::set_focus(pool, focus).await?;
    }
    Ok(ResponseJson(ApiResponse::success(())))
}

/// The turns of the one thread that had this mission in focus (J1.2).
async fn mission_turns(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<Uuid>>>, ApiError> {
    let turns = db::models::fluke_event::FlukeGuard::turns_of(&deployment.db().pool, id).await?;
    Ok(ResponseJson(ApiResponse::success(turns)))
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
    /// Repo de la misión; sólo editable antes de mandar el brief al Analyst.
    pub repo_id: Option<Uuid>,
    /// Dónde está el user en la app; va en el system prompt de cada turno.
    pub ui_context: Option<String>,
    /// `true` cierra (archiva) la misión; `false` la restaura.
    pub close: Option<bool>,
}

async fn update_mission(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateMissionRequest>,
) -> Result<ResponseJson<ApiResponse<MissionDetail>>, ApiError> {
    let pool = &deployment.db().pool;
    let current = load(&deployment, id).await?;
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
    if let Some(repo_id) = payload.repo_id {
        if current.analyst_task_id.is_some() {
            return Err(ApiError::Conflict(
                "The brief was already sent; the repo can't change".to_string(),
            ));
        }
        if db::models::repo::Repo::find_by_id(pool, repo_id).await?.is_none() {
            return Err(ApiError::BadRequest("Unknown repo".to_string()));
        }
        Mission::set_repo(pool, id, Some(repo_id)).await?;
    }
    if let Some(ctx) = &payload.ui_context {
        Mission::set_ui_context(pool, id, Some(ctx.as_str())).await?;
    }
    match payload.close {
        Some(true) => Mission::set_status(pool, id, mission::STATUS_CLOSED).await?,
        // Restore: back to planning if the brief already went to the
        // Analyst; otherwise clarifying, and refresh_status settles it.
        Some(false) if current.status == mission::STATUS_CLOSED => {
            let status = if current.analyst_task_id.is_some() {
                mission::STATUS_PLANNING
            } else {
                mission::STATUS_CLARIFYING
            };
            Mission::set_status(pool, id, status).await?;
        }
        _ => {}
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

    // Design issues already closed by their mock get an implementation issue
    // instead of being reused (#757). The issues the last run created only
    // reach the local mirror on a sync, so refresh it first; if that fails the
    // prompt asks the Analyst to check the unmirrored ones itself.
    if !d.issue_numbers.is_empty()
        && let Err(e) = services::services::repo_issues::RepoIssuesService::new()
            .sync(pool, deployment.git(), repo_id)
            .await
    {
        tracing::warn!(mission_id = %id, "issue mirror sync before the brief revision failed: {e}");
    }
    let closed_designs = director::closed_design_issues(
        pool,
        Some(deployment.git()),
        d.mission.repo_id,
        &d.issue_numbers,
    )
    .await?;
    let markdown = director::render_markdown(&d);
    let version = Mission::add_brief_version(pool, id, &markdown).await?;
    let task = WorkerTask::append(
        pool,
        analyst.id,
        &CreateWorkerTask {
            repo_id,
            title: d.mission.title.chars().take(80).collect(),
            prompt: director::analyst_request_prompt(&d, version, &closed_designs),
            source: SOURCE_MISSION.to_string(),
            ..Default::default()
        },
    )
    .await?;
    Mission::set_analyst_task(pool, id, task.id).await?;
    Mission::set_status(pool, id, mission::STATUS_PLANNING).await?;

    // Si el analista está libre arranca ya; si no,
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
            let out = match name {
                "get_stuck_issues" | "answer_agent" => {
                    unstick_tool(&deployment, session_id, name, &args).await
                }
                "new_mission" => new_mission_tool(&deployment, session_id, &args).await,
                _ => director::call_tool(&deployment.db().pool, session_id, name, &args).await,
            };
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

/// Herramientas de destrabe del Director (fluke v2, #702): necesitan el
/// container para retomar la sesión del agente, por eso viven acá.
async fn unstick_tool(
    deployment: &DeploymentImpl,
    session_id: Uuid,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    use services::services::{
        issue_phases, plan as plan_service, stuck_task_detector, worker_orchestrator,
    };
    let pool = &deployment.db().pool;
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    let mission = Mission::find_by_session_id(pool, session_id)
        .await
        .map_err(db_err)?
        .ok_or("this session has no mission")?;
    let max_rounds =
        worker_orchestrator::resolve_max_review_rounds(&*deployment.config().read().await);
    let stuck_minutes = stuck_task_detector::threshold_minutes();

    // Which repos to look at: the one asked for; else the mission's; in the
    // standing conversation (no brief, no single repo), every repo (J1.1).
    let repos: Vec<db::models::repo::Repo> =
        match args.get("repo").and_then(Value::as_str).filter(|r| !r.trim().is_empty()) {
            Some(repo) => vec![director::resolve_repo(pool, repo).await?],
            None if db::models::fluke_event::FlukeGuard::is_guard(pool, mission.id)
                .await
                .map_err(db_err)? =>
            {
                db::models::repo::Repo::list_all(pool).await.map_err(db_err)?
            }
            None => {
                let repo_id = mission
                    .repo_id
                    .ok_or("the mission has no repo yet: set it with set_mission")?;
                db::models::repo::Repo::find_by_id(pool, repo_id)
                    .await
                    .map_err(db_err)?
                    .into_iter()
                    .collect()
            }
        };

    if name == "get_stuck_issues" {
        let mut out: Vec<Value> = Vec::new();
        for repo in &repos {
            let list = issue_phases::list_blockers(pool, repo.id, max_rounds, stuck_minutes)
                .await
                .map_err(db_err)?;
            out.extend(list.into_iter().map(|e| {
                json!({
                    "repo": repo.display_name,
                    "issue_number": e.issue_number,
                    "kind": e.blocker.kind,
                    "phase": e.blocker.phase,
                    "message": e.blocker.message,
                    "question": e.blocker.question
                        .as_deref()
                        .and_then(|q| serde_json::from_str::<Value>(q).ok()),
                })
            }));
        }
        return Ok(Value::Array(out).to_string());
    }

    let n = args
        .get("issue_number")
        .and_then(Value::as_i64)
        .ok_or("missing issue_number")?;
    let answer = args
        .get("answer")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .ok_or("missing answer")?;

    // The agent waiting in issue #n, among the repos in scope.
    let mut waiting = Vec::new();
    for repo in &repos {
        let Some(issue) =
            db::models::repo_issue::RepoIssue::find_by_repo_and_number(pool, repo.id, n)
                .await
                .map_err(db_err)?
        else {
            continue;
        };
        let plan = issue_phases::load_issue_plan(
            pool,
            repo.id,
            n,
            issue.state != "open",
            issue.body.as_deref(),
            max_rounds,
            stuck_minutes,
        )
        .await
        .map_err(db_err)?;
        if let Some(blocker) = plan.blocker.filter(|b| b.kind == "question")
            && let (Some(workspace_id), Some(raw)) = (blocker.workspace_id, blocker.question)
        {
            waiting.push((repo.display_name.clone(), workspace_id, raw));
        }
    }
    let (workspace_id, raw) = match waiting.len() {
        0 => return Err(format!("no agent is waiting for an answer in #{n}")),
        1 => {
            let (_, workspace_id, raw) = waiting.remove(0);
            (workspace_id, raw)
        }
        _ => {
            let names: Vec<String> = waiting.into_iter().map(|(name, _, _)| name).collect();
            return Err(format!(
                "#{n} is waiting in more than one repo ({}): pass the repo",
                names.join(", ")
            ));
        }
    };
    let question: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    plan_service::answer_question(
        pool,
        deployment.container(),
        workspace_id,
        &question,
        answer,
    )
    .await?;
    Ok(format!("Answer sent to the agent of #{n}; it carries on."))
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

// ---------------------------------------------------------------------------
// Conversación de guardia (J0.3): los eventos del bus le llegan a Fluke
// ---------------------------------------------------------------------------

/// Cada cuánto se mira el bus.
const EVENT_POLL: std::time::Duration = std::time::Duration::from_secs(10);
/// Como mucho un lote por minuto: cada lote es un turno de Fluke.
// ponytail: fixed gap; make it a setting if a busy factory needs faster alerts.
const MIN_DELIVERY_GAP_SECS: i64 = 60;
const EVENTS_PER_BATCH: i64 = 100;

/// Arranca el watcher de la guardia: lee `fluke_events` y le manda a la
/// misión fija de Fluke lo que no es progreso puro, en lotes.
pub fn spawn_event_watcher(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(EVENT_POLL);
        loop {
            tick.tick().await;
            if let Err(e) = deliver_events(&deployment).await {
                tracing::debug!("Fluke event watcher: {e}");
            }
        }
    });
}

/// La misión de guardia; la crea (en el primer repo) si todavía no existe.
async fn ensure_guard(
    deployment: &DeploymentImpl,
) -> Result<Option<db::models::fluke_event::FlukeGuard>, ApiError> {
    use db::models::{fluke_event::FlukeGuard, repo::Repo};
    let pool = &deployment.db().pool;
    if let Some(guard) = FlukeGuard::get(pool).await?
        && Mission::find_by_id(pool, guard.mission_id).await?.is_some()
    {
        return Ok(Some(guard));
    }
    let Some(repo) = Repo::list_all(pool).await?.into_iter().next() else {
        return Ok(None);
    };
    let mission = new_mission_in(deployment, repo.id).await?;
    Mission::set_title(pool, mission.id, "Fluke").await?;
    FlukeGuard::set(pool, mission.id).await?;
    Ok(FlukeGuard::get(pool).await?)
}

async fn deliver_events(deployment: &DeploymentImpl) -> Result<(), ApiError> {
    use db::models::fluke_event::{FlukeEvent, FlukeGuard, SEVERITY_PROGRESS};
    let pool = &deployment.db().pool;
    // Until the server knows its own address, Fluke would start without its MCP.
    if utils::plan_mcp::director_url_for_session("").is_none() {
        return Ok(());
    }
    let Some(guard) = ensure_guard(deployment).await? else {
        return Ok(());
    };
    if guard
        .secs_since_delivery
        .is_some_and(|s| s < MIN_DELIVERY_GAP_SECS)
    {
        return Ok(());
    }
    let events = FlukeEvent::list_after(pool, guard.event_cursor, EVENTS_PER_BATCH).await?;
    let Some(last) = events.last().map(|e| e.id) else {
        return Ok(());
    };
    // Progress is for the UI; the guard's own mission events are Fluke's.
    let worth: Vec<FlukeEvent> = events
        .into_iter()
        .filter(|e| e.severity != SEVERITY_PROGRESS && e.subject_id != Some(guard.mission_id))
        .collect();
    if worth.is_empty() {
        FlukeGuard::advance(pool, last, false).await?;
        return Ok(());
    }
    // Never interrupt Fluke mid-reply: the batch waits for the next tick.
    if Mission::agent_running(pool, guard.mission_id).await? {
        return Ok(());
    }
    let mission = load(deployment, guard.mission_id).await?;
    let session = Session::find_by_id(pool, mission.session_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("guard session not found".into()))?;
    let worker = director::ensure_orchestrator(pool).await?;
    let executor_config = director::executor_config(&*deployment.config().read().await, &worker)
        .map_err(ApiError::BadRequest)?;
    let _process = crate::routes::sessions::follow_up(
        axum::Extension(session),
        State(deployment.clone()),
        Json(crate::routes::sessions::CreateFollowUpAttempt {
            prompt: director::events_message(&worth),
            executor_config,
            retry_process_id: None,
            force_when_dirty: None,
            perform_git_reset: None,
        }),
    )
    .await?;
    FlukeGuard::advance(pool, last, true).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Canal de turno (J2.1): una entrada para chat, voz, celular y relay
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, TS)]
pub struct DirectorTurnRequest {
    pub text: String,
    /// `chat` (default) or `voice`: a voice turn asks Fluke for short spoken
    /// replies.
    pub channel: Option<String>,
}

/// Send `text` to Fluke's thread and stream its reply as SSE: `delta`
/// events with the text as it is written, then one `done` (`{text,
/// is_error}`). 409 while Fluke is still answering the previous turn.
async fn director_turn(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<DirectorTurnRequest>,
) -> Result<
    axum::response::sse::Sse<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
    ApiError,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::StreamExt;
    use services::services::container::ContainerService;
    use utils::log_msg::LogMsg;

    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err(ApiError::BadRequest("empty text".into()));
    }
    let pool = &deployment.db().pool;
    let guard = ensure_guard(&deployment)
        .await?
        .ok_or_else(|| ApiError::BadRequest("register a repo first".into()))?;
    if Mission::agent_running(pool, guard.mission_id).await? {
        return Err(ApiError::Conflict("Fluke is still answering".into()));
    }
    let mission = load(&deployment, guard.mission_id).await?;
    let session = Session::find_by_id(pool, mission.session_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Fluke's session not found".into()))?;
    if req.channel.as_deref() == Some("voice") {
        director::mark_voice_turn(mission.id);
    }
    let worker = director::ensure_orchestrator(pool).await?;
    let executor_config = director::executor_config(&*deployment.config().read().await, &worker)
        .map_err(ApiError::BadRequest)?;
    let process = crate::routes::sessions::follow_up(
        axum::Extension(session),
        State(deployment.clone()),
        Json(crate::routes::sessions::CreateFollowUpAttempt {
            prompt: text,
            executor_config,
            retry_process_id: None,
            force_when_dirty: None,
            perform_git_reset: None,
        }),
    )
    .await?
    .0
    .into_data()
    .ok_or_else(|| ApiError::BadRequest("the turn did not start".into()))?;
    let store = deployment
        .container()
        .get_msg_store_by_id(&process.id)
        .await
        .ok_or_else(|| ApiError::BadRequest("the turn has no output".into()))?;

    // Stdout arrives in chunks, not lines: split them before parsing.
    let events = store
        .history_plus_stream()
        .scan(String::new(), |buf: &mut String, msg: Result<LogMsg, std::io::Error>| {
            let mut out: Vec<Event> = Vec::new();
            let mut finished = false;
            match msg {
                Ok(LogMsg::Stdout(chunk)) => {
                    buf.push_str(&chunk);
                    while let Some(end) = buf.find('\n') {
                        let line: String = buf.drain(..=end).collect();
                        match director::turn_event(&line) {
                            Some(director::TurnEvent::Delta(t)) => {
                                out.push(Event::default().event("delta").data(t));
                            }
                            Some(director::TurnEvent::Done { text, is_error }) => {
                                out.push(Event::default().event("done").data(
                                    json!({ "text": text, "is_error": is_error }).to_string(),
                                ));
                                finished = true;
                            }
                            None => {}
                        }
                    }
                }
                Ok(LogMsg::Finished) | Err(_) => finished = true,
                _ => {}
            }
            futures_util::future::ready((!(finished && out.is_empty())).then_some((out, finished)))
        })
        .scan(false, |ended, (out, finished)| {
            // Stop right after the turn's last events.
            let emit = if *ended { None } else { Some(out) };
            *ended |= finished;
            futures_util::future::ready(emit)
        })
        .flat_map(|out: Vec<Event>| futures_util::stream::iter(out.into_iter().map(Ok)));
    Ok(Sse::new(events).keep_alive(KeepAlive::default()))
}
