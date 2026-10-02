//! Plan de trabajo estructurado de un agente: herramientas del MCP de plan,
//! checkpoints de git por paso, control de ejecución (pausa al terminar el
//! paso, stop, play, revertir) y el ciclo de revisión de pasos.

use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc, time::Duration};

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    plan::{self, NewPlanStep, Plan, PlanSnapshot, PlanStep, PlanStepRevision, StepProposal},
    session::Session,
    worker_task::{self, WorkerTask},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    },
    command::CommandBuilder,
};
use futures::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio_stream::wrappers::BroadcastStream;
use utils::{command_ext::NoWindowExt, log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

use crate::services::container::ContainerService;

type Pool = sqlx::SqlitePool;

// ---------------------------------------------------------------------------
// Snapshot y stream
// ---------------------------------------------------------------------------

pub async fn publish(pool: &Pool, msg_store: &MsgStore, workspace_id: Uuid) {
    match Plan::snapshot(pool, workspace_id).await {
        Ok(Some(snap)) => push_snapshot(msg_store, &snap),
        Ok(None) => {}
        Err(e) => tracing::warn!("plan: snapshot failed for {workspace_id}: {e}"),
    }
}

fn push_snapshot(msg_store: &MsgStore, snap: &PlanSnapshot) {
    let patch = json!([{ "op": "replace", "path": "/plan", "value": snap }]);
    if let Ok(patch) = serde_json::from_value(patch) {
        msg_store.push_patch(patch);
    }
}

/// Snapshot inicial + cambios del plan de un workspace (formato JSON patch
/// para `useJsonPatchWsStream`).
pub async fn stream_raw(
    pool: &Pool,
    msg_store: Arc<MsgStore>,
    workspace_id: Uuid,
) -> Result<BoxStream<'static, Result<LogMsg, std::io::Error>>, sqlx::Error> {
    let snap = Plan::snapshot(pool, workspace_id).await?;
    let initial = json!([{ "op": "replace", "path": "/plan", "value": snap }]);
    let initial = LogMsg::JsonPatch(serde_json::from_value(initial).expect("valid patch"));
    let ws = workspace_id.to_string();
    let live = BroadcastStream::new(msg_store.get_receiver()).filter_map(move |msg| {
        let ws = ws.clone();
        async move {
            match msg {
                Ok(LogMsg::JsonPatch(patch)) => {
                    let op = patch.0.first()?;
                    if op.path() != "/plan" {
                        return None;
                    }
                    let value = match op {
                        json_patch::PatchOperation::Replace(r) => &r.value,
                        _ => return None,
                    };
                    (value.get("workspace_id").and_then(Value::as_str) == Some(ws.as_str()))
                        .then(|| Ok(LogMsg::JsonPatch(patch)))
                }
                _ => None,
            }
        }
    });
    Ok(futures::stream::iter(vec![Ok(initial), Ok(LogMsg::Ready)])
        .chain(live)
        .boxed())
}

// ---------------------------------------------------------------------------
// Herramientas del MCP de plan
// ---------------------------------------------------------------------------

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "submit_plan",
            "description": "Declare your work plan before editing any file. Each step: n (1-based order), title, summary (what you will do), files (paths you expect to touch), verify (how you will check it), depends_on (step numbers). Calling it again replaces the steps that are not done yet.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "n": { "type": "integer" },
                                "title": { "type": "string" },
                                "summary": { "type": "string" },
                                "files": { "type": "array", "items": { "type": "string" } },
                                "verify": { "type": "string" },
                                "depends_on": { "type": "array", "items": { "type": "integer" } }
                            },
                            "required": ["n", "title", "summary"]
                        }
                    }
                },
                "required": ["steps"]
            }
        },
        {
            "name": "start_step",
            "description": "Call before working on step n. Returns the current version of the step, which the user may have edited: follow it as written. It may instead tell you to stop and end your turn.",
            "inputSchema": {
                "type": "object",
                "properties": { "n": { "type": "integer" } },
                "required": ["n"]
            }
        },
        {
            "name": "complete_step",
            "description": "Call when step n is finished and verified. Returns what to do next, which may be to end your turn.",
            "inputSchema": {
                "type": "object",
                "properties": { "n": { "type": "integer" } },
                "required": ["n"]
            }
        },
        {
            "name": "ask_user",
            "description": "Ask the user ONE decision you cannot settle by reading the code or the task (product choice, missing input, conflicting requirements). Give short options (key + text), the one you recommend and why. The task waits for the answer: after calling it, end your turn; the answer arrives as your next message. Calling it again replaces the pending question.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string" },
                    "options": {
                        "type": "array",
                        "maxItems": MAX_OPTIONS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": { "type": "string" },
                                "text": { "type": "string" }
                            },
                            "required": ["key", "text"]
                        }
                    },
                    "recommended": { "type": "string", "description": "key of the option you recommend" },
                    "why": { "type": "string", "description": "why you recommend it" }
                },
                "required": ["question", "options", "recommended", "why"]
            }
        }
    ])
}

const MAX_OPTIONS: usize = 4;

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct AskOption {
    key: String,
    text: String,
}

/// Pregunta de `ask_user`, guardada como JSON en `worker_tasks.pending_question`.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct AskUserQuestion {
    question: String,
    options: Vec<AskOption>,
    recommended: String,
    why: String,
}

fn parse_question(args: &Value) -> Result<AskUserQuestion, String> {
    let mut q: AskUserQuestion =
        serde_json::from_value(args.clone()).map_err(|e| format!("invalid question: {e}"))?;
    q.options
        .retain(|o| !o.key.trim().is_empty() && !o.text.trim().is_empty());
    if q.question.trim().is_empty() {
        return Err("the question is empty".into());
    }
    if q.options.is_empty() || q.options.len() > MAX_OPTIONS {
        return Err(format!("give between 1 and {MAX_OPTIONS} options"));
    }
    let mut keys = std::collections::HashSet::new();
    if !q.options.iter().all(|o| keys.insert(o.key.as_str())) {
        return Err("option keys must be unique".into());
    }
    if !keys.contains(q.recommended.as_str()) {
        return Err("recommended must be the key of one of the options".into());
    }
    Ok(q)
}

/// Ejecuta una herramienta del MCP de plan. `Err` se devuelve al agente como
/// resultado con `isError`.
pub async fn call_tool(
    pool: &Pool,
    msg_store: &MsgStore,
    workspace_id: Uuid,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    let n_arg = || {
        args.get("n")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing integer argument n".to_string())
    };
    let out = match name {
        "submit_plan" => {
            let steps: Vec<NewPlanStep> =
                serde_json::from_value(args.get("steps").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("invalid steps: {e}"))?;
            if steps.is_empty() {
                return Err("the plan needs at least one step".into());
            }
            let mut seen = std::collections::HashSet::new();
            if !steps.iter().all(|s| seen.insert(s.n)) {
                return Err("step numbers (n) must be unique".into());
            }
            let existing = PlanStep::list(pool, workspace_id).await.map_err(db_err)?;
            if let Some(active) = existing.iter().find(|s| s.state == plan::STEP_ACTIVE) {
                return Err(format!(
                    "step {} is in progress: call complete_step({}) before submitting a new plan",
                    active.n, active.n
                ));
            }
            if let Some(clash) = existing
                .iter()
                .find(|s| s.state == plan::STEP_DONE && seen.contains(&s.n))
            {
                return Err(format!(
                    "step {} is already done; number new steps after it",
                    clash.n
                ));
            }
            Plan::ensure(pool, workspace_id).await.map_err(db_err)?;
            PlanStep::replace_open(pool, workspace_id, &steps)
                .await
                .map_err(db_err)?;
            format!(
                "Plan saved with {} steps. Before working on a step call start_step(n); when it \
                 is done and verified call complete_step(n). Always follow the step text that \
                 start_step returns: the user may have edited it.",
                steps.len()
            )
        }
        "start_step" => {
            let n = n_arg()?;
            if Plan::find(pool, workspace_id)
                .await
                .map_err(db_err)?
                .is_none()
            {
                return Err("no plan yet: call submit_plan first".into());
            }
            let step = PlanStep::find(pool, workspace_id, n)
                .await
                .map_err(db_err)?
                .ok_or_else(|| format!("step {n} does not exist in the plan"))?;
            if step.state == plan::STEP_CUT {
                return Err(format!(
                    "the user removed step {n} from the plan; skip it and continue with the next step"
                ));
            }
            if Plan::consume_pause(pool, workspace_id)
                .await
                .map_err(db_err)?
            {
                publish(pool, msg_store, workspace_id).await;
                return Ok(format!(
                    "PAUSE REQUESTED by the user. Do not start step {n}. End your turn now with \
                     a one-line status; you will be resumed later."
                ));
            }
            let checkpoint = snapshot_workspace(pool, workspace_id, n).await;
            PlanStep::start(pool, workspace_id, n, checkpoint.as_ref())
                .await
                .map_err(db_err)?;
            PlanStepRevision::ack_for_step(pool, workspace_id, n)
                .await
                .map_err(db_err)?;
            let edited = if step.version > 1 {
                format!(
                    " The user edited this step (version {}): follow it as written.",
                    step.version
                )
            } else {
                String::new()
            };
            format!("Start step {n}.{edited}\n{}", render_step(&step))
        }
        "complete_step" => {
            let n = n_arg()?;
            if PlanStep::find(pool, workspace_id, n)
                .await
                .map_err(db_err)?
                .is_none()
            {
                return Err(format!("step {n} does not exist in the plan"));
            }
            PlanStep::set_state(pool, workspace_id, n, plan::STEP_DONE)
                .await
                .map_err(db_err)?;
            PlanStepRevision::ack_for_step(pool, workspace_id, n)
                .await
                .map_err(db_err)?;
            if Plan::consume_pause(pool, workspace_id)
                .await
                .map_err(db_err)?
            {
                format!(
                    "Step {n} marked done. PAUSE REQUESTED by the user: do not start another \
                     step. End your turn now with a one-line status; you will be resumed later."
                )
            } else {
                match next_pending(pool, workspace_id).await.map_err(db_err)? {
                    Some(next) => format!(
                        "Step {n} marked done. Next: step {} - {}.",
                        next.n, next.title
                    ),
                    None => format!("Step {n} marked done. All plan steps are done."),
                }
            }
        }
        "ask_user" => {
            let q = parse_question(args)?;
            let task = WorkerTask::find_by_workspace(pool, workspace_id)
                .await
                .map_err(db_err)?
                .ok_or("ask_user only works inside a fluke task: ask in your reply instead")?;
            let json = serde_json::to_string(&q).map_err(|e| e.to_string())?;
            if !WorkerTask::set_waiting_user(pool, task.id, &json)
                .await
                .map_err(db_err)?
            {
                return Err(format!(
                    "the task is {}, not in progress: ask in your final message instead",
                    task.status
                ));
            }
            return Ok(
                "Question shown to the user. End your turn now without further work; the \
                 answer will arrive as your next message."
                    .into(),
            );
        }
        other => return Err(format!("unknown tool {other}")),
    };
    publish(pool, msg_store, workspace_id).await;
    Ok(out)
}

pub fn render_step(step: &PlanStep) -> String {
    let mut s = format!(
        "Step {} (version {}): {}\n{}",
        step.n, step.version, step.title, step.summary
    );
    if !step.files.is_empty() {
        s.push_str(&format!("\nFiles: {}", step.files.join(", ")));
    }
    if let Some(v) = step.verify.as_deref().filter(|v| !v.is_empty()) {
        s.push_str(&format!("\nVerify: {v}"));
    }
    s
}

async fn next_pending(pool: &Pool, workspace_id: Uuid) -> Result<Option<PlanStep>, sqlx::Error> {
    Ok(PlanStep::list(pool, workspace_id)
        .await?
        .into_iter()
        .find(|s| s.state == plan::STEP_PENDING))
}

const PLAN_TOOLS_HINT: &str = "Load the plan tools with ToolSearch (query \
     \"select:mcp__fluke_plan__submit_plan,mcp__fluke_plan__start_step,mcp__fluke_plan__complete_step\")";

/// Gate del protocolo de plan para herramientas que editan archivos, en los
/// workers con tarea (el chat suelto no se frena). `Some(motivo)` rechaza la
/// llamada y el motivo le dice al agente qué herramienta de plan usar.
pub async fn gate(
    pool: &Pool,
    execution_process_id: Uuid,
    tool_name: &str,
    tool_input: &Value,
) -> Option<String> {
    let process = ExecutionProcess::find_by_id(pool, execution_process_id)
        .await
        .ok()??;
    let session = Session::find_by_id(pool, process.session_id).await.ok()??;
    gate_for_workspace(pool, session.workspace_id, tool_name, tool_input).await
}

async fn gate_for_workspace(
    pool: &Pool,
    workspace_id: Uuid,
    tool_name: &str,
    tool_input: &Value,
) -> Option<String> {
    WorkerTask::find_by_workspace(pool, workspace_id)
        .await
        .ok()??;
    // El outbox de acciones (.vk/actions.json) no es código del plan.
    let path = tool_input
        .get("file_path")
        .or_else(|| tool_input.get("notebook_path"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .replace('\\', "/");
    if path.starts_with(".vk/") || path.contains("/.vk/") {
        return None;
    }
    let plan = Plan::find(pool, workspace_id).await.ok()?;
    let steps = PlanStep::list(pool, workspace_id).await.ok()?;
    if plan.is_none() || steps.is_empty() {
        return Some(format!(
            "fluke: {tool_name} is blocked until you declare your work plan. {PLAN_TOOLS_HINT}, \
             call mcp__fluke_plan__submit_plan with small verifiable steps, then \
             mcp__fluke_plan__start_step(1), and retry this edit."
        ));
    }
    // Pausa pedida = terminar el paso en curso, así que solo frena si el
    // plan ya está detenido.
    if plan.is_some_and(|p| p.status != plan::STATUS_RUNNING) {
        return Some(
            "fluke: the user stopped this plan. Do not edit files: end your turn now with a \
             one-line status."
                .into(),
        );
    }
    if !steps.iter().any(|s| s.state == plan::STEP_ACTIVE) {
        let next = steps
            .iter()
            .find(|s| s.state == plan::STEP_PENDING)
            .map(|s| s.n.to_string())
            .unwrap_or_else(|| "n".into());
        return Some(format!(
            "fluke: no plan step is in progress. {PLAN_TOOLS_HINT} if needed and call \
             mcp__fluke_plan__start_step({next}) for the step this edit belongs to (or \
             submit_plan again if the work is not in the plan), then retry."
        ));
    }
    None
}

/// Revisiones aceptadas mientras el agente trabajaba, como contexto para el
/// hook PostToolUse. Tomarlas las marca como entregadas.
pub async fn take_injection(pool: &Pool, execution_process_id: Uuid) -> Option<String> {
    let process = ExecutionProcess::find_by_id(pool, execution_process_id)
        .await
        .ok()??;
    let session = Session::find_by_id(pool, process.session_id).await.ok()??;
    let items = PlanStepRevision::take_undelivered_live(pool, session.workspace_id)
        .await
        .ok()?;
    if items.is_empty() {
        return None;
    }
    let mut text = String::from("fluke plan update from the user:");
    for (rev, step) in items {
        if step.n == rev.n {
            text.push_str(&format!(
                "\n\nStep {} was revised (version {}). Follow this version from now on and \
                 adjust what you already did for it:\n{}",
                step.n,
                step.version,
                render_step(&step)
            ));
        } else {
            text.push_str(&format!(
                "\n\nThe user added step {} to correct step {} (already done). Do it after your \
                 current step, with start_step({}) / complete_step({}):\n{}",
                step.n,
                rev.n,
                step.n,
                step.n,
                render_step(&step)
            ));
        }
    }
    Some(text)
}

// ---------------------------------------------------------------------------
// Checkpoints de git
// ---------------------------------------------------------------------------

async fn git(dir: &Path, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "fluke")
        .env("GIT_AUTHOR_EMAIL", "fluke@localhost")
        .env("GIT_COMMITTER_NAME", "fluke")
        .env("GIT_COMMITTER_EMAIL", "fluke@localhost")
        .no_window();
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Commit con el estado completo del worktree (incluye cambios sin commitear
/// y archivos nuevos) sin tocar el índice real ni la rama.
async fn snapshot_repo(dir: &Path, reference: &str) -> Result<String, String> {
    let index = std::env::temp_dir().join(format!("fluke-plan-{}.idx", Uuid::new_v4()));
    let result = async {
        git(dir, &["read-tree", "HEAD"], Some(&index)).await?;
        git(dir, &["add", "-A"], Some(&index)).await?;
        let tree = git(dir, &["write-tree"], Some(&index)).await?;
        let commit = git(
            dir,
            &[
                "commit-tree",
                &tree,
                "-p",
                "HEAD",
                "-m",
                "fluke plan checkpoint",
            ],
            None,
        )
        .await?;
        git(dir, &["update-ref", reference, &commit], None).await?;
        Ok(commit)
    }
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    result
}

/// Deja el worktree exactamente como en el checkpoint: rama en el HEAD de
/// ese momento y los cambios sin commitear de entonces.
async fn restore_repo(dir: &Path, commit: &str) -> Result<(), String> {
    git(dir, &["reset", "--hard", &format!("{commit}^")], None).await?;
    git(dir, &["clean", "-fd"], None).await?;
    git(dir, &["read-tree", "--reset", "-u", commit], None).await?;
    git(dir, &["reset", "-q"], None).await?;
    Ok(())
}

async fn repo_dirs(
    pool: &Pool,
    workspace: &Workspace,
) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let root = workspace
        .container_ref
        .as_ref()
        .ok_or("workspace has no worktree")?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(repos
        .into_iter()
        .map(|r| {
            let dir = Path::new(root).join(&r.name);
            (r.name, dir)
        })
        .filter(|(_, dir)| dir.exists())
        .collect())
}

fn ref_name(workspace_id: Uuid, n: i64, repo: &str) -> String {
    let repo: String = repo
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("refs/fluke/plan/{workspace_id}/{n}-{repo}")
}

async fn snapshot_workspace(
    pool: &Pool,
    workspace_id: Uuid,
    n: i64,
) -> Option<HashMap<String, String>> {
    let workspace = Workspace::find_by_id(pool, workspace_id).await.ok()??;
    let dirs = match repo_dirs(pool, &workspace).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("plan: no checkpoint for step {n}: {e}");
            return None;
        }
    };
    let mut out = HashMap::new();
    for (name, dir) in dirs {
        match snapshot_repo(&dir, &ref_name(workspace_id, n, &name)).await {
            Ok(sha) => {
                out.insert(name, sha);
            }
            Err(e) => {
                tracing::warn!("plan: checkpoint of {name} for step {n} failed: {e}");
                return None;
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Control de ejecución
// ---------------------------------------------------------------------------

async fn agent_running(pool: &Pool, workspace_id: Uuid) -> bool {
    ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
        .await
        .unwrap_or(false)
}

pub async fn set_pause(
    pool: &Pool,
    msg_store: &MsgStore,
    workspace_id: Uuid,
    on: bool,
) -> Result<(), String> {
    Plan::set_pause_requested(pool, workspace_id, on)
        .await
        .map_err(|e| e.to_string())?;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

pub async fn stop(
    pool: &Pool,
    msg_store: &MsgStore,
    container: &(impl ContainerService + Sync),
    workspace_id: Uuid,
) -> Result<(), String> {
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("workspace not found")?;
    // Antes de cortar: el fin del proceso no debe finalizar el worker.
    Plan::set_status(pool, workspace_id, plan::STATUS_HALTED)
        .await
        .map_err(|e| e.to_string())?;
    Plan::set_pause_requested(pool, workspace_id, false)
        .await
        .map_err(|e| e.to_string())?;
    container.try_stop(&workspace, false).await;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

pub async fn play(
    pool: &Pool,
    msg_store: &MsgStore,
    container: &(impl ContainerService + Sync),
    workspace_id: Uuid,
) -> Result<(), String> {
    let e = |e: sqlx::Error| e.to_string();
    if Plan::find(pool, workspace_id).await.map_err(e)?.is_none() {
        return Err("this workspace has no plan".into());
    }
    if agent_running(pool, workspace_id).await {
        // Play mientras corre = cancelar la pausa pedida.
        Plan::set_pause_requested(pool, workspace_id, false)
            .await
            .map_err(e)?;
        publish(pool, msg_store, workspace_id).await;
        return Ok(());
    }
    let steps = PlanStep::list(pool, workspace_id).await.map_err(e)?;
    let note = Plan::take_resume_note(pool, workspace_id)
        .await
        .map_err(e)?;
    let mut prompt = note.map(|n| format!("{n}\n\n")).unwrap_or_default();
    if let Some(active) = steps.iter().find(|s| s.state == plan::STEP_ACTIVE) {
        prompt.push_str(&format!(
            "The user stopped you during step {} and now resumes. Check the current state of \
             the worktree and continue that step (do not call start_step again for it):\n{}",
            active.n,
            render_step(active)
        ));
    } else if let Some(next) = steps.iter().find(|s| s.state == plan::STEP_PENDING) {
        prompt.push_str(&format!(
            "Resume the plan. Continue with step {}: call start_step({}) first.",
            next.n, next.n
        ));
    } else {
        prompt.push_str(
            "Resume: every plan step is done. Finish the task (final checks, commit) as your \
             instructions say.",
        );
    }
    Plan::set_status(pool, workspace_id, plan::STATUS_RUNNING)
        .await
        .map_err(e)?;
    Plan::set_pause_requested(pool, workspace_id, false)
        .await
        .map_err(e)?;
    follow_up(pool, container, workspace_id, &prompt).await?;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

/// Revierte el worktree al checkpoint del paso `n` y deja el plan en pausa
/// con ese paso como siguiente. Los pasos posteriores vuelven a pendiente.
pub async fn revert_to_step(
    pool: &Pool,
    msg_store: &MsgStore,
    container: &(impl ContainerService + Sync),
    workspace_id: Uuid,
    n: i64,
) -> Result<(), String> {
    let e = |e: sqlx::Error| e.to_string();
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .map_err(e)?
        .ok_or("workspace not found")?;
    let checkpoint = PlanStep::checkpoint(pool, workspace_id, n)
        .await
        .map_err(e)?
        .ok_or_else(|| format!("step {n} has no checkpoint (it never started)"))?;

    Plan::set_status(pool, workspace_id, plan::STATUS_HALTED)
        .await
        .map_err(e)?;
    if agent_running(pool, workspace_id).await {
        container.try_stop(&workspace, false).await;
        for _ in 0..40 {
            if !agent_running(pool, workspace_id).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    for (name, dir) in repo_dirs(pool, &workspace).await? {
        if let Some(commit) = checkpoint.get(&name) {
            restore_repo(&dir, commit).await?;
        }
    }

    let later: Vec<i64> = PlanStep::list(pool, workspace_id)
        .await
        .map_err(e)?
        .into_iter()
        .filter(|s| s.n >= n)
        .map(|s| s.n)
        .collect();
    PlanStep::reset(pool, workspace_id, &later)
        .await
        .map_err(e)?;
    Plan::set_status(pool, workspace_id, plan::STATUS_PAUSED)
        .await
        .map_err(e)?;
    Plan::set_pause_requested(pool, workspace_id, false)
        .await
        .map_err(e)?;
    Plan::set_resume_note(
        pool,
        workspace_id,
        Some(&format!(
            "The user reverted step {n}: the worktree was restored to its exact state before \
             step {n} started, and every change from step {n} onwards was discarded. Redo the \
             plan from step {n}, following the current text of each step."
        )),
    )
    .await
    .map_err(e)?;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

/// Pregunta de `ask_user` que espera respuesta en el workspace, si hay.
pub async fn pending_question(pool: &Pool, workspace_id: Uuid) -> Result<Option<Value>, String> {
    let e = |e: sqlx::Error| e.to_string();
    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id)
        .await
        .map_err(e)?
        .filter(|t| t.status == worker_task::STATUS_WAITING_USER)
    else {
        return Ok(None);
    };
    Ok(WorkerTask::pending_question(pool, task.id)
        .await
        .map_err(e)?
        .and_then(|j| serde_json::from_str(&j).ok()))
}

/// Respuesta del user a la pregunta de `ask_user`: `answer` es la clave de
/// una opción o una respuesta libre, y `question` la pregunta que responde
/// (los argumentos de esa llamada a `ask_user`). Si ya no es la pendiente
/// (respondida o reemplazada) se rechaza. Llega como mensaje a la misma sesión.
pub async fn answer_question(
    pool: &Pool,
    container: &(impl ContainerService + Sync),
    workspace_id: Uuid,
    question: &Value,
    answer: &str,
) -> Result<(), String> {
    answer_with(pool, workspace_id, question, answer, |prompt| async move {
        follow_up(pool, container, workspace_id, &prompt).await
    })
    .await
}

async fn answer_with<F, Fut>(
    pool: &Pool,
    workspace_id: Uuid,
    question: &Value,
    answer: &str,
    send: F,
) -> Result<(), String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let e = |e: sqlx::Error| e.to_string();
    let answer = answer.trim();
    if answer.is_empty() {
        return Err("the answer is empty".into());
    }
    let task = WorkerTask::find_by_workspace(pool, workspace_id)
        .await
        .map_err(e)?
        .filter(|t| t.status == worker_task::STATUS_WAITING_USER)
        .ok_or("no question is waiting for an answer in this workspace")?;
    if agent_running(pool, workspace_id).await {
        return Err("the agent is still ending its turn; try again in a moment".into());
    }
    let pending: Option<AskUserQuestion> = WorkerTask::pending_question(pool, task.id)
        .await
        .map_err(e)?
        .and_then(|j| serde_json::from_str(&j).ok());
    let answered: Option<AskUserQuestion> = serde_json::from_value(question.clone()).ok();
    let q = match (pending, answered) {
        (Some(p), Some(a)) if p.question == a.question && p.options == a.options => p,
        _ => {
            return Err(
                "this question is no longer pending: it was answered or replaced by a newer one"
                    .into(),
            );
        }
    };
    let picked = q
        .options
        .iter()
        .find(|o| o.key == answer)
        .map(|o| format!("option {}: {}", o.key, o.text))
        .unwrap_or_else(|| answer.to_string());
    let prompt = format!(
        "The user answered your question \"{}\": {picked}\nContinue the task with this decision.",
        q.question
    );
    // A in_progress antes de mandar: si el turno nuevo terminara antes, el
    // cierre vería waiting_user y no finalizaría la tarea.
    if !WorkerTask::resume_from_waiting_user(pool, task.id)
        .await
        .map_err(e)?
    {
        return Err("the question was already answered".into());
    }
    if let Err(err) = send(prompt).await {
        // Sin sesión a la que mandar: la pregunta sigue pendiente.
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_WAITING_USER)
            .await
            .map_err(e)?;
        return Err(err);
    }
    WorkerTask::clear_pending_question(pool, task.id)
        .await
        .map_err(e)?;
    Ok(())
}

/// Nuevo turno del agente sobre su sesión (mismo executor y configuración).
async fn follow_up(
    pool: &Pool,
    container: &(impl ContainerService + Sync),
    workspace_id: Uuid,
    prompt: &str,
) -> Result<(), String> {
    let e = |e: sqlx::Error| e.to_string();
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .map_err(e)?
        .ok_or("workspace not found")?;
    let session = Session::find_latest_by_workspace_id(pool, workspace_id)
        .await
        .map_err(e)?
        .ok_or("workspace has no session")?;
    let latest = ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace_id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await
    .map_err(e)?
    .ok_or("the agent never ran in this workspace")?;
    let executor_config = match &latest.executor_action().map_err(|e| e.to_string())?.typ {
        ExecutorActionType::CodingAgentInitialRequest(req) => req.executor_config.clone(),
        ExecutorActionType::CodingAgentFollowUpRequest(req) => req.executor_config.clone(),
        _ => return Err("unexpected executor action".into()),
    };
    let session_info = CodingAgentTurn::find_latest_session_info_for_executor(
        pool,
        session.id,
        &executor_config.executor.to_string(),
    )
    .await
    .map_err(e)?
    .ok_or("no agent session to resume")?;
    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|d| !d.is_empty())
        .cloned();
    let action = ExecutorAction::new(
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: prompt.to_string(),
            session_id: session_info.session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        }),
        None,
    );
    container
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Ciclo de revisión de un paso
// ---------------------------------------------------------------------------

pub async fn request_revision(
    pool: &Pool,
    msg_store: Arc<MsgStore>,
    workspace_id: Uuid,
    n: i64,
    request: String,
) -> Result<Uuid, String> {
    let e = |e: sqlx::Error| e.to_string();
    let step = PlanStep::find(pool, workspace_id, n)
        .await
        .map_err(e)?
        .ok_or_else(|| format!("step {n} not found"))?;
    let open = PlanStepRevision::open_for_step(pool, workspace_id, n)
        .await
        .map_err(e)?;
    let (round, base) = match open {
        Some(r) if r.status == plan::REV_REQUESTED => {
            return Err("a revision of this step is already being prepared".into());
        }
        Some(r) => {
            // "Pedir otro cambio": la ronda nueva parte de la propuesta previa.
            PlanStepRevision::set_status(pool, r.id, plan::REV_DISCARDED, None)
                .await
                .map_err(e)?;
            (r.round + 1, r.proposal)
        }
        None => (1, None),
    };
    let id = PlanStepRevision::create(pool, workspace_id, n, round, &request)
        .await
        .map_err(e)?;
    publish(pool, &msg_store, workspace_id).await;

    let pool = pool.clone();
    tokio::spawn(async move {
        match run_reviewer(&pool, workspace_id, &step, base.as_ref(), &request).await {
            Ok(p) => {
                let _ = PlanStepRevision::set_proposal(&pool, id, &p).await;
            }
            Err(err) => {
                tracing::warn!("plan: reviewer failed for step {n}: {err}");
                let _ = PlanStepRevision::set_failed(&pool, id, &err).await;
            }
        }
        publish(&pool, &msg_store, workspace_id).await;
    });
    Ok(id)
}

fn step_json(step: &PlanStep) -> Value {
    json!({ "title": step.title, "summary": step.summary, "files": step.files, "verify": step.verify })
}

/// Revisor: fork de la sesión del agente en modo plan (solo lectura), así
/// propone la versión nueva con todo el contexto sin tocar al worker.
async fn run_reviewer(
    pool: &Pool,
    workspace_id: Uuid,
    step: &PlanStep,
    base: Option<&StepProposal>,
    request: &str,
) -> Result<StepProposal, String> {
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("workspace not found")?;
    let root = workspace
        .container_ref
        .clone()
        .ok_or("workspace has no worktree")?;
    let session = Session::find_latest_by_workspace_id(pool, workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    let mut cwd = std::path::PathBuf::from(&root);
    if let Some(dir) = session
        .as_ref()
        .and_then(|s| s.agent_working_dir.as_ref())
        .filter(|d| !d.is_empty())
    {
        cwd = cwd.join(dir);
    }
    let agent_session = match &session {
        Some(s) => CodingAgentTurn::find_latest_session_info(pool, s.id)
            .await
            .map_err(|e| e.to_string())?
            .map(|i| i.session_id),
        None => None,
    };

    let mut params: Vec<String> = vec!["-p".into()];
    if let Some(sid) = &agent_session {
        params.extend(["--resume".into(), sid.clone(), "--fork-session".into()]);
    }
    params.extend([
        "--permission-mode".into(),
        "plan".into(),
        "--output-format".into(),
        "json".into(),
    ]);
    let (program, args) = CommandBuilder::new(executors::executors::claude::base_command(false))
        .params(params)
        .build_initial()
        .map_err(|e| e.to_string())?
        .into_resolved()
        .await
        .map_err(|e| e.to_string())?;

    let base_text = base
        .map(|b| {
            format!(
                "\nYour previous proposal, which the user wants changed further:\n{}\n",
                serde_json::to_string_pretty(b).unwrap_or_default()
            )
        })
        .unwrap_or_default();
    let prompt = format!(
        "You are helping the user revise ONE step of the plan you are executing in this \
         repository. Do not modify any file and do not run commands that change state.\n\n\
         Current step {} (version {}):\n{}\n{}\nThe user's requested change:\n\"{}\"\n\n\
         Reply with ONLY a JSON object, no prose and no code fences, with keys: title, summary, \
         files (array of paths), verify (string or null), changes (array of short strings \
         saying what changed compared to the current step), impact (one sentence about the \
         effect on the other steps of the plan). Write changes and impact in the same language \
         as the user's request.",
        step.n,
        step.version,
        serde_json::to_string_pretty(&step_json(step)).unwrap_or_default(),
        base_text,
        request
    );

    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NPM_CONFIG_LOGLEVEL", "error")
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|e| format!("could not start the reviewer: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(Duration::from_secs(300), child.wait_with_output())
        .await
        .map_err(|_| "the reviewer took too long".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let result = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .ok_or_else(|| {
            format!(
                "the reviewer returned no result: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
        })?;
    let text = result
        .get("result")
        .and_then(Value::as_str)
        .ok_or("the reviewer returned an empty result")?;
    parse_proposal(text)
}

fn parse_proposal(text: &str) -> Result<StepProposal, String> {
    let start = text
        .find('{')
        .ok_or("the reviewer did not reply with JSON")?;
    let end = text
        .rfind('}')
        .ok_or("the reviewer did not reply with JSON")?;
    serde_json::from_str(&text[start..=end]).map_err(|e| format!("invalid proposal: {e}"))
}

pub async fn accept_revision(
    pool: &Pool,
    msg_store: &MsgStore,
    container: &(impl ContainerService + Sync),
    revision_id: Uuid,
) -> Result<(), String> {
    let e = |e: sqlx::Error| e.to_string();
    let (workspace_id, rev) = PlanStepRevision::find(pool, revision_id)
        .await
        .map_err(e)?
        .ok_or("revision not found")?;
    if rev.status != plan::REV_PROPOSED {
        return Err("only a proposed revision can be accepted".into());
    }
    let proposal = rev.proposal.clone().ok_or("revision has no proposal")?;
    let step = PlanStep::find(pool, workspace_id, rev.n)
        .await
        .map_err(e)?
        .ok_or("step not found")?;

    if step.state == plan::STEP_DONE {
        // El paso ya se hizo: el cambio va como paso de corrección.
        let m = PlanStep::next_n(pool, workspace_id).await.map_err(e)?;
        PlanStep::insert(
            pool,
            workspace_id,
            &NewPlanStep {
                n: m,
                title: format!("Corrección del paso {}: {}", rev.n, proposal.title),
                summary: format!("{}\n\nPedido del user: {}", proposal.summary, rev.request),
                files: proposal.files.clone(),
                verify: proposal.verify.clone(),
                depends_on: vec![rev.n],
            },
        )
        .await
        .map_err(e)?;
        PlanStepRevision::set_status(pool, rev.id, plan::REV_ACCEPTED, Some(m))
            .await
            .map_err(e)?;
        let plan_running = Plan::find(pool, workspace_id)
            .await
            .map_err(e)?
            .is_some_and(|p| p.status == plan::STATUS_RUNNING);
        if plan_running && !agent_running(pool, workspace_id).await {
            PlanStepRevision::set_status(pool, rev.id, plan::REV_DELIVERED, None)
                .await
                .map_err(e)?;
            follow_up(
                pool,
                container,
                workspace_id,
                &format!(
                    "The user added step {m} to the plan to correct step {} (already done). \
                     Call start_step({m}) and do it.",
                    rev.n
                ),
            )
            .await?;
        }
    } else {
        PlanStep::apply_proposal(pool, workspace_id, rev.n, &proposal)
            .await
            .map_err(e)?;
        PlanStepRevision::set_status(pool, rev.id, plan::REV_ACCEPTED, Some(rev.n))
            .await
            .map_err(e)?;
    }
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

pub async fn discard_revision(
    pool: &Pool,
    msg_store: &MsgStore,
    revision_id: Uuid,
) -> Result<(), String> {
    let (workspace_id, _) = PlanStepRevision::find(pool, revision_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("revision not found")?;
    PlanStepRevision::set_status(pool, revision_id, plan::REV_DISCARDED, None)
        .await
        .map_err(|e| e.to_string())?;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

/// Tachar o restaurar un paso pendiente desde la UI.
pub async fn set_step_cut(
    pool: &Pool,
    msg_store: &MsgStore,
    workspace_id: Uuid,
    n: i64,
    cut: bool,
) -> Result<(), String> {
    let step = PlanStep::find(pool, workspace_id, n)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("step not found")?;
    let allowed = if cut {
        step.state == plan::STEP_PENDING
    } else {
        step.state == plan::STEP_CUT
    };
    if !allowed {
        return Err("only a pending step can be removed".into());
    }
    let state = if cut {
        plan::STEP_CUT
    } else {
        plan::STEP_PENDING
    };
    PlanStep::set_state(pool, workspace_id, n, state)
        .await
        .map_err(|e| e.to_string())?;
    publish(pool, msg_store, workspace_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proposal_with_surrounding_prose() {
        let p = parse_proposal(
            "Here you go:\n{\"title\":\"T\",\"summary\":\"S\",\"files\":[\"a.ts\"],\"verify\":null,\"changes\":[\"x\"],\"impact\":\"none\"}\nDone.",
        )
        .unwrap();
        assert_eq!(p.title, "T");
        assert_eq!(p.files, vec!["a.ts"]);
        assert!(parse_proposal("no json here").is_err());
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Plan completo contra una base real y un repo git real: declarar,
    /// arrancar (con checkpoint), cerrar, pausar en el borde y restaurar el
    /// worktree exacto del inicio del paso.
    #[tokio::test]
    async fn plan_flow_with_pause_and_checkpoint_restore() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("app");
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "v0").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-qm", "init"]);
        let head0 = sh(&dir, &["rev-parse", "HEAD"]);

        let ws = Uuid::new_v4();
        let repo = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name, parallel_setup_script)
             VALUES (?1, ?2, 'app', 'app', 0)",
        )
        .bind(repo)
        .bind(dir.to_string_lossy().to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO workspaces (id, container_ref, branch) VALUES (?1, ?2, 'b')")
            .bind(ws)
            .bind(tmp.path().to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch)
             VALUES (?1, ?2, ?3, 'main')",
        )
        .bind(Uuid::new_v4())
        .bind(ws)
        .bind(repo)
        .execute(&pool)
        .await
        .unwrap();
        let store = MsgStore::new();

        let steps = json!({ "steps": [
            { "n": 1, "title": "Uno", "summary": "s1", "files": ["a.txt"] },
            { "n": 2, "title": "Dos", "summary": "s2", "depends_on": [1] }
        ]});
        let out = call_tool(&pool, &store, ws, "submit_plan", &steps)
            .await
            .unwrap();
        assert!(out.contains("2 steps"));
        assert!(
            call_tool(&pool, &store, ws, "start_step", &json!({ "n": 9 }))
                .await
                .is_err()
        );

        // Estado sucio al iniciar el paso 1: cambio sin commitear + archivo nuevo.
        std::fs::write(dir.join("a.txt"), "v0-dirty").unwrap();
        std::fs::write(dir.join("u.txt"), "untracked").unwrap();
        let out = call_tool(&pool, &store, ws, "start_step", &json!({ "n": 1 }))
            .await
            .unwrap();
        assert!(out.starts_with("Start step 1."));
        let s1 = PlanStep::find(&pool, ws, 1).await.unwrap().unwrap();
        assert_eq!(s1.state, plan::STEP_ACTIVE);
        assert!(s1.has_checkpoint);
        // El checkpoint no toca la rama ni el índice real.
        assert_eq!(sh(&dir, &["rev-parse", "HEAD"]), head0);

        // Trabajo del paso: commit, archivo nuevo, borrado.
        std::fs::write(dir.join("a.txt"), "v1").unwrap();
        sh(&dir, &["commit", "-qam", "step1"]);
        std::fs::write(dir.join("n.txt"), "new").unwrap();
        std::fs::remove_file(dir.join("u.txt")).unwrap();

        // Pausa pedida: complete_step la consume y pide cerrar el turno.
        set_pause(&pool, &store, ws, true).await.unwrap();
        let out = call_tool(&pool, &store, ws, "complete_step", &json!({ "n": 1 }))
            .await
            .unwrap();
        assert!(out.contains("PAUSE REQUESTED"));
        assert!(Plan::is_on_hold(&pool, ws).await.unwrap());
        let snap = Plan::snapshot(&pool, ws).await.unwrap().unwrap();
        assert!(!snap.pause_requested);
        assert_eq!(snap.steps[0].state, plan::STEP_DONE);

        // Restaurar el checkpoint deja el worktree como al iniciar el paso.
        let ckpt = PlanStep::checkpoint(&pool, ws, 1).await.unwrap().unwrap();
        restore_repo(&dir, &ckpt["app"]).await.unwrap();
        assert_eq!(sh(&dir, &["rev-parse", "HEAD"]), head0);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "v0-dirty"
        );
        assert!(dir.join("u.txt").exists());
        assert!(!dir.join("n.txt").exists());
        // Los cambios quedan sin commitear, como estaban.
        assert!(sh(&dir, &["status", "--porcelain"]).contains("a.txt"));
    }

    #[tokio::test]
    async fn gate_forces_the_plan_protocol_on_worker_edits() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let ws = Uuid::new_v4();
        let edit = json!({ "file_path": "src/app.ts" });

        // Chat suelto (sin tarea): nunca se frena.
        assert!(gate_for_workspace(&pool, ws, "Edit", &edit).await.is_none());

        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, status, workspace_id)
             VALUES (?1, ?2, ?3, 0, 't', 'p', 'in_progress', ?4)",
        )
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(ws)
        .execute(&pool)
        .await
        .unwrap();

        // Worker sin plan: frena y dice qué llamar.
        let why = gate_for_workspace(&pool, ws, "Edit", &edit).await.unwrap();
        assert!(why.contains("mcp__fluke_plan__submit_plan"));
        // El outbox de acciones no se frena.
        let outbox = json!({ "file_path": "C:\\wt\\repo\\.vk\\actions.json" });
        assert!(
            gate_for_workspace(&pool, ws, "Write", &outbox)
                .await
                .is_none()
        );

        // Plan declarado pero sin paso en curso: pide start_step del siguiente.
        let store = MsgStore::new();
        let steps = json!({ "steps": [{ "n": 1, "title": "Uno", "summary": "s" }] });
        call_tool(&pool, &store, ws, "submit_plan", &steps)
            .await
            .unwrap();
        let why = gate_for_workspace(&pool, ws, "Edit", &edit).await.unwrap();
        assert!(why.contains("start_step(1)"));

        // Paso en curso: pasa, aunque haya una pausa pedida (termina el paso).
        PlanStep::start(&pool, ws, 1, None).await.unwrap();
        Plan::set_pause_requested(&pool, ws, true).await.unwrap();
        assert!(gate_for_workspace(&pool, ws, "Edit", &edit).await.is_none());

        // Plan detenido: frena.
        Plan::set_status(&pool, ws, plan::STATUS_HALTED)
            .await
            .unwrap();
        assert!(gate_for_workspace(&pool, ws, "Edit", &edit).await.is_some());
    }

    #[tokio::test]
    async fn accepted_revision_of_active_step_is_injected_once() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let ws = Uuid::new_v4();
        Plan::ensure(&pool, ws).await.unwrap();
        PlanStep::replace_open(
            &pool,
            ws,
            &[NewPlanStep {
                n: 1,
                title: "Hook".into(),
                summary: "old".into(),
                files: vec![],
                verify: None,
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
        PlanStep::start(&pool, ws, 1, None).await.unwrap();
        let rev = PlanStepRevision::create(&pool, ws, 1, 1, "no toques api.ts")
            .await
            .unwrap();
        let proposal = StepProposal {
            title: "Hook".into(),
            summary: "new".into(),
            files: vec![],
            verify: None,
            changes: vec!["x".into()],
            impact: None,
        };
        PlanStepRevision::set_proposal(&pool, rev, &proposal)
            .await
            .unwrap();
        PlanStep::apply_proposal(&pool, ws, 1, &proposal)
            .await
            .unwrap();
        PlanStepRevision::set_status(&pool, rev, plan::REV_ACCEPTED, Some(1))
            .await
            .unwrap();

        let first = PlanStepRevision::take_undelivered_live(&pool, ws)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].1.version, 2);
        assert_eq!(first[0].1.summary, "new");
        assert!(
            PlanStepRevision::take_undelivered_live(&pool, ws)
                .await
                .unwrap()
                .is_empty()
        );
        PlanStepRevision::ack_for_step(&pool, ws, 1).await.unwrap();
        let revs = PlanStepRevision::list(&pool, ws).await.unwrap();
        assert_eq!(revs[0].status, plan::REV_ACKED);
    }

    /// ask_user: la tarea pasa a waiting_user con la pregunta, una segunda
    /// pregunta reemplaza a la primera, y responder vuelve a in_progress solo
    /// si el mensaje llega a la sesión.
    #[tokio::test]
    async fn ask_user_parks_the_task_until_answered() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let store = MsgStore::new();
        let ws = Uuid::new_v4();
        let ask = |q: &str| {
            json!({
                "question": q,
                "options": [{ "key": "A", "text": "Keep it" }, { "key": "B", "text": "Drop it" }],
                "recommended": "B",
                "why": "less code"
            })
        };

        // Chat suelto (sin tarea): no hay a quién dejar esperando.
        assert!(
            call_tool(&pool, &store, ws, "ask_user", &ask("first?"))
                .await
                .is_err()
        );

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, status, workspace_id)
             VALUES (?1, ?2, ?3, 0, 't', 'p', 'in_progress', ?4)",
        )
        .bind(task_id)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(ws)
        .execute(&pool)
        .await
        .unwrap();

        // Recomendada que no es una opción: error, la tarea sigue en curso.
        let mut bad = ask("first?");
        bad["recommended"] = json!("Z");
        assert!(
            call_tool(&pool, &store, ws, "ask_user", &bad)
                .await
                .is_err()
        );
        let status = |pool: Pool| async move {
            WorkerTask::find_by_id(&pool, task_id)
                .await
                .unwrap()
                .unwrap()
                .status
        };
        assert_eq!(status(pool.clone()).await, worker_task::STATUS_IN_PROGRESS);

        let out = call_tool(&pool, &store, ws, "ask_user", &ask("first?"))
            .await
            .unwrap();
        assert!(out.contains("End your turn"));
        assert_eq!(status(pool.clone()).await, worker_task::STATUS_WAITING_USER);
        call_tool(&pool, &store, ws, "ask_user", &ask("second?"))
            .await
            .unwrap();
        let pending = WorkerTask::pending_question(&pool, task_id)
            .await
            .unwrap()
            .unwrap();
        assert!(pending.contains("second?") && !pending.contains("first?"));
        assert_eq!(
            super::pending_question(&pool, ws).await.unwrap().unwrap()["question"],
            "second?"
        );

        // Card vieja (pregunta reemplazada): se rechaza sin mandar nada.
        let err = answer_with(&pool, ws, &ask("first?"), "A", |_| async {
            panic!("a stale answer must not reach the agent")
        })
        .await
        .unwrap_err();
        assert!(err.contains("no longer pending"));
        assert_eq!(status(pool.clone()).await, worker_task::STATUS_WAITING_USER);

        // La sesión ya no existe: error y la tarea sigue esperando.
        let err = answer_with(&pool, ws, &ask("second?"), "B", |_| async {
            Err::<(), String>("workspace has no session".into())
        })
        .await
        .unwrap_err();
        assert!(err.contains("no session"));
        assert_eq!(status(pool.clone()).await, worker_task::STATUS_WAITING_USER);
        assert!(
            WorkerTask::pending_question(&pool, task_id)
                .await
                .unwrap()
                .is_some()
        );

        // Respuesta por clave: llega con el texto de la opción.
        let sent = std::sync::Mutex::new(String::new());
        answer_with(&pool, ws, &ask("second?"), "B", |p| {
            *sent.lock().unwrap() = p;
            async { Ok(()) }
        })
        .await
        .unwrap();
        let sent = sent.into_inner().unwrap();
        assert!(sent.contains("second?") && sent.contains("option B: Drop it"));
        assert_eq!(status(pool.clone()).await, worker_task::STATUS_IN_PROGRESS);
        assert!(
            WorkerTask::pending_question(&pool, task_id)
                .await
                .unwrap()
                .is_none()
        );

        // Ya respondida: no se manda dos veces.
        assert!(
            answer_with(&pool, ws, &ask("second?"), "otra cosa", |_| async {
                Ok(())
            })
            .await
            .is_err()
        );
    }

    #[test]
    fn ref_names_are_git_safe() {
        let id = Uuid::nil();
        assert_eq!(
            ref_name(id, 3, "my repo/x"),
            format!("refs/fluke/plan/{id}/3-my-repo-x")
        );
    }
}
