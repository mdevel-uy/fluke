//! Director (en la UI, "Fluke"): agente orquestador global.
//!
//! Conversa con el user en una sesión por misión, separa el pedido en ítems
//! (bug / feature / diseño) y los registra en un brief estructurado por su
//! MCP (`/api/director-mcp/{session_id}`). Qué campos son obligatorios y
//! cuándo el brief está completo lo decide este módulo, nunca el modelo. El
//! traspaso al Analista (G1) es un botón del user, no una herramienta.
//!
//! Además es el mayordomo de la app: `app_api` llama cualquier endpoint del
//! backend local, así todo lo que hace la UI lo puede hacer Fluke (pensado
//! para manejar fluke sin pantalla, por voz). `app_api_reference` busca en el
//! cliente de API del frontend y en los tipos compartidos, embebidos al
//! compilar, para que encuentre la ruta y la forma del body.

use std::collections::BTreeMap;

use db::models::{
    fluke_event::FlukeGuard,
    mission::{self, Mission, MissionBrief, MissionItem, PendingQuestion},
    repo::Repo,
    repo_issue::RepoIssue,
    worker::{CreateWorker, ROLE_ORCHESTRATOR, Worker},
};
use executors::{
    executors::BaseCodingAgent, model_selector::PermissionPolicy, profile::ExecutorConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;
use uuid::Uuid;

use crate::services::config::Config;

type Pool = sqlx::SqlitePool;

pub const MAX_QUESTIONS: usize = 3;
const MAX_OPTIONS: usize = 4;

// What the UI can do, as the UI does it: every call with its method, path
// and body type. Embedded so the catalog never drifts from the app.
const API_CLIENT: &str = include_str!("../../../../packages/web-core/src/shared/lib/api.ts");
const API_TYPES: &str = include_str!("../../../../shared/types.ts");
const API_REFERENCE_MAX: usize = 12_000;
const API_RESPONSE_MAX: usize = 20_000;

// ---------------------------------------------------------------------------
// Esquema del brief
// ---------------------------------------------------------------------------

pub const KINDS: [&str; 3] = ["bug", "feature", "design"];

/// (campo, obligatorio, etiqueta en el markdown del brief)
type FieldSpec = (&'static str, bool, &'static str);

const BUG_FIELDS: &[FieldSpec] = &[
    ("symptom", true, "Síntoma"),
    ("steps", true, "Pasos para reproducir"),
    ("acceptance", true, "Criterio de aceptación"),
    ("tdd", true, "TDD"),
];
const FEATURE_FIELDS: &[FieldSpec] = &[
    ("goal", true, "Objetivo"),
    ("scope", true, "Alcance"),
    ("acceptance", true, "Criterio de aceptación"),
    ("tdd", true, "TDD"),
];
const DESIGN_FIELDS: &[FieldSpec] = &[
    ("goal", true, "Objetivo"),
    ("scope", true, "Alcance (incluye mobile)"),
    ("reference", false, "Referencia"),
];

fn kind_fields(kind: &str) -> &'static [FieldSpec] {
    match kind {
        "bug" => BUG_FIELDS,
        "feature" => FEATURE_FIELDS,
        "design" => DESIGN_FIELDS,
        _ => &[],
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "bug" => "Bug",
        "feature" => "Feature",
        "design" => "Diseño",
        _ => "?",
    }
}

/// Roles de worker que necesita un ítem. La Fase 2 los cruza con el equipo.
pub fn required_roles(kind: &str) -> &'static [&'static str] {
    match kind {
        "design" => &["designer"],
        _ => &["developer", "reviewer"],
    }
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct FieldCheck {
    pub key: String,
    pub required: bool,
    pub filled: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct MissionItemView {
    pub item: MissionItem,
    pub checklist: Vec<FieldCheck>,
}

impl MissionItemView {
    fn missing(&self) -> impl Iterator<Item = &str> {
        self.checklist
            .iter()
            .filter(|f| f.required && !f.filled)
            .map(|f| f.key.as_str())
    }
}

fn item_view(item: MissionItem) -> MissionItemView {
    let checklist = kind_fields(&item.kind)
        .iter()
        .map(|(key, required, _)| FieldCheck {
            key: key.to_string(),
            required: *required,
            filled: item.fields.get(*key).is_some_and(|v| !v.trim().is_empty()),
        })
        .collect();
    MissionItemView { item, checklist }
}

/// Lo que le falta al brief para estar completo. Vacío = completo.
/// Códigos: `title`, `repo`, `items`, `item:<n>:<campo>` (n desde 1).
fn missing(mission: &Mission, items: &[MissionItemView]) -> Vec<String> {
    let mut out = Vec::new();
    if mission.title.trim().is_empty() {
        out.push("title".to_string());
    }
    if mission.repo_id.is_none() {
        out.push("repo".to_string());
    }
    if items.is_empty() {
        out.push("items".to_string());
    }
    for (i, view) in items.iter().enumerate() {
        for key in view.missing() {
            out.push(format!("item:{}:{key}", i + 1));
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct MissionDetail {
    pub mission: Mission,
    pub repo_name: Option<String>,
    pub items: Vec<MissionItemView>,
    pub missing: Vec<String>,
    pub complete: bool,
    pub roles_needed: Vec<String>,
    pub briefs: Vec<MissionBrief>,
    #[ts(type = "Array<number>")]
    pub issue_numbers: Vec<i64>,
    /// Status of the Analyst's breakdown task, once the brief was handed over.
    pub analyst_status: Option<String>,
    /// The issues the Analyst created, with milestone and wave (#700).
    pub proposal: Vec<MissionProposalIssue>,
    /// `none` (nothing dispatched), `planning` (devs started, no plan steps
    /// yet) or `running` (at least one dev submitted its plan).
    pub execution: String,
    /// Fluke's standing conversation (J0.3): app events land here, no brief.
    pub is_guard: bool,
}

/// An issue of the Analyst's breakdown, for the mission stepper (#700).
#[derive(Debug, Clone, Serialize, TS)]
pub struct MissionProposalIssue {
    #[ts(type = "number")]
    pub number: i64,
    pub title: String,
    pub state: String,
    pub milestone: Option<String>,
    #[ts(type = "number | null")]
    pub wave: Option<i64>,
    /// Carries `pm:decision`: it waits for the user.
    pub decision: bool,
}

/// Issues of the mission as the Analyst left them on GitHub.
async fn proposal(
    pool: &Pool,
    repo_id: Option<Uuid>,
    numbers: &[i64],
) -> Result<Vec<MissionProposalIssue>, sqlx::Error> {
    let Some(repo_id) = repo_id else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for &n in numbers {
        let Some(issue) = RepoIssue::find_by_repo_and_number(pool, repo_id, n).await? else {
            continue;
        };
        let labels: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&issue.labels)
            .unwrap_or_default()
            .iter()
            .filter_map(|l| l.get("name")?.as_str().map(str::to_string))
            .collect();
        out.push(MissionProposalIssue {
            number: n,
            title: issue.title,
            state: issue.state,
            milestone: issue.milestone,
            wave: labels
                .iter()
                .find_map(|l| crate::services::execution_labels::wave_number(l)),
            decision: labels.iter().any(|l| l == "pm:decision"),
        });
    }
    Ok(out)
}

/// How far the execution of the mission's issues went (see `execution`).
async fn execution(
    pool: &Pool,
    repo_id: Option<Uuid>,
    numbers: &[i64],
) -> Result<&'static str, sqlx::Error> {
    let Some(repo_id) = repo_id else {
        return Ok("none");
    };
    let mut started = false;
    for &n in numbers {
        let (tasks, planned): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(EXISTS (SELECT 1 FROM plan_steps p WHERE p.workspace_id = t.workspace_id)), 0)
               FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
              WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND w.role = 'developer'",
        )
        .bind(repo_id)
        .bind(n)
        .fetch_one(pool)
        .await?;
        if planned > 0 {
            return Ok("running");
        }
        started |= tasks > 0;
    }
    Ok(if started { "planning" } else { "none" })
}

pub async fn detail(pool: &Pool, mission: Mission) -> Result<MissionDetail, sqlx::Error> {
    let items: Vec<MissionItemView> = Mission::items(pool, mission.id)
        .await?
        .into_iter()
        .map(item_view)
        .collect();
    let repo_name = match mission.repo_id {
        Some(id) => Repo::find_by_id(pool, id).await?.map(|r| r.display_name),
        None => None,
    };
    let missing = missing(&mission, &items);
    let mut roles_needed: Vec<String> = items
        .iter()
        .flat_map(|v| required_roles(&v.item.kind).iter().map(|r| r.to_string()))
        .collect();
    roles_needed.sort();
    roles_needed.dedup();
    let issue_numbers = Mission::issue_numbers(pool, mission.id).await?;
    let analyst_status = match mission.analyst_task_id {
        Some(id) => {
            sqlx::query_scalar("SELECT status FROM worker_tasks WHERE id = ?1")
                .bind(id)
                .fetch_optional(pool)
                .await?
        }
        None => None,
    };
    Ok(MissionDetail {
        is_guard: FlukeGuard::is_guard(pool, mission.id).await?,
        briefs: Mission::briefs(pool, mission.id).await?,
        proposal: proposal(pool, mission.repo_id, &issue_numbers).await?,
        execution: execution(pool, mission.repo_id, &issue_numbers)
            .await?
            .to_string(),
        analyst_status,
        issue_numbers,
        complete: missing.is_empty(),
        mission,
        repo_name,
        items,
        missing,
        roles_needed,
    })
}

/// Editar los ítems de un brief ya enviado abre una revisión: la misión
/// vuelve a armarse y el user tiene que aprobar la versión nueva.
async fn reopen_if_sent(pool: &Pool, mission: &Mission) -> Result<(), sqlx::Error> {
    if mission.status == mission::STATUS_PLANNING {
        Mission::set_status(pool, mission.id, mission::STATUS_CLARIFYING).await?;
    }
    Ok(())
}

/// Mientras se arma el brief, el estado lo deriva el código: completo →
/// `brief_ready`, si no → `clarifying`. Después del traspaso no se toca.
pub async fn refresh_status(pool: &Pool, mission_id: Uuid) -> Result<MissionDetail, sqlx::Error> {
    let mission = Mission::find_by_id(pool, mission_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    let mut d = detail(pool, mission).await?;
    if matches!(
        d.mission.status.as_str(),
        mission::STATUS_DRAFT | mission::STATUS_CLARIFYING | mission::STATUS_BRIEF_READY
    ) {
        let next = if d.complete {
            mission::STATUS_BRIEF_READY
        } else {
            mission::STATUS_CLARIFYING
        };
        if d.mission.status != next {
            Mission::set_status(pool, mission_id, next).await?;
            d.mission.status = next.to_string();
        }
    }
    Ok(d)
}

pub fn render_markdown(d: &MissionDetail) -> String {
    let mut md = format!("# {}\n\n", d.mission.title.trim());
    md.push_str(&format!(
        "- **Repo:** {}\n- **Roles necesarios:** {}\n",
        d.repo_name.as_deref().unwrap_or("-"),
        d.roles_needed.join(", ")
    ));
    for (i, view) in d.items.iter().enumerate() {
        let item = &view.item;
        md.push_str(&format!(
            "\n## {}. [{}] {}\n\n",
            i + 1,
            kind_label(&item.kind),
            item.title.trim()
        ));
        for (key, _, label) in kind_fields(&item.kind) {
            if let Some(value) = item.fields.get(*key) {
                md.push_str(&format!("**{label}:**\n\n{}\n\n", value.trim()));
            }
        }
    }
    md
}

/// Prompt de la request que recibe el Analista al aprobar el brief.
pub fn analyst_request_prompt(d: &MissionDetail, version: i64) -> String {
    let revision = if d.issue_numbers.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = d.issue_numbers.iter().map(|n| format!("#{n}")).collect();
        format!(
            "Revisión: las versiones anteriores del brief ya se partieron en {}. \
             Creá issues solo para lo nuevo o lo que cambió; no dupliques los existentes.\n\n",
            list.join(", ")
        )
    };
    format!(
        "Brief de la misión \"{title}\" (versión {version}), aprobado por el user.\n\n\
         {md}\n---\n\
         {revision}Partí cada ítem del brief en issues chicos y asignables. En el cuerpo de cada \
         issue agregá una sección \"## Brief\" que diga \"Misión: {title} (brief v{version})\" \
         y copie los campos del ítem del que sale. No cambies el alcance del brief: si algo \
         no cierra, listalo como pregunta abierta.\n\n\
         Plan de fases (fluke v2): al final del cuerpo de cada issue que salga de un bug o \
         una feature agregá en una línea sola el bloque \
         <!-- fluke:plan {{\"template\":\"tdd\"}} --> si el campo TDD del ítem es \"sí\", o \
         <!-- fluke:plan {{\"template\":\"no_tdd\"}} --> si es \"no\" o \"no aplica\". \
         Los issues de ítems de diseño no llevan el bloque.",
        title = d.mission.title.trim(),
        md = render_markdown(d),
    )
}

// ---------------------------------------------------------------------------
// Worker del Director y ejecución
// ---------------------------------------------------------------------------

const DEFAULT_SOUL: &str = "Sos Fluke, el director de esta instalación. Hablás claro y corto, \
preguntás solo lo necesario y nunca das por sentado algo que el user no dijo.";

/// El worker del Director; lo crea la primera vez que se usa.
pub async fn ensure_orchestrator(pool: &Pool) -> Result<Worker, sqlx::Error> {
    if let Some(worker) = Worker::find_orchestrator(pool).await? {
        return Ok(worker);
    }
    Worker::create(
        pool,
        &CreateWorker {
            name: "Fluke".to_string(),
            emoji: "\u{2726}".to_string(),
            soul: DEFAULT_SOUL.to_string(),
            role: Some(ROLE_ORCHESTRATOR.to_string()),
            executor: Some(BaseCodingAgent::ClaudeCode),
            model: None,
            github_pat: None,
            github_login: None,
            plan_mode: None,
        },
    )
    .await
}

/// El Director usa el executor global con el modelo de su worker. Las
/// herramientas MCP sólo llegan con Claude Code, así que otro executor no
/// sirve. Nunca en modo plan: necesita llamar a sus herramientas.
pub fn executor_config(config: &Config, worker: &Worker) -> Result<ExecutorConfig, String> {
    let mut executor_config: ExecutorConfig = config.executor_profile.clone().into();
    if executor_config.executor != BaseCodingAgent::ClaudeCode {
        return Err(format!(
            "Fluke needs Claude Code as the coding agent (current: {})",
            executor_config.executor
        ));
    }
    executor_config.model_id = worker.model.clone();
    executor_config.permission_policy = Some(PermissionPolicy::Auto);
    Ok(executor_config)
}

/// El user respondió: las preguntas pendientes quedan contestadas, una
/// acción peligrosa pendiente queda habilitada (si el mensaje empieza con
/// "sí") o cancelada (cualquier otra cosa), y una misión nueva pasa a
/// `clarifying`.
pub async fn on_user_message(
    pool: &Pool,
    mission: &Mission,
    prompt: &str,
) -> Result<(), sqlx::Error> {
    // A batch of app events is not the user talking: it neither answers the
    // open questions nor confirms or cancels an action.
    if prompt.starts_with(EVENTS_PREFIX) {
        return Ok(());
    }
    confirmations::on_user_message(mission.id, prompt);
    if !mission.pending_questions.is_empty() {
        Mission::set_pending_questions(pool, mission.id, &[]).await?;
    }
    if mission.status == mission::STATUS_DRAFT {
        Mission::set_status(pool, mission.id, mission::STATUS_CLARIFYING).await?;
    }
    Ok(())
}

const SYSTEM_PROMPT: &str = "\
You are Fluke, the butler of the fluke app (a desktop app where a team of AI workers \
- developers, analysts, reviewers, designers - builds software), like Jarvis. The user must be \
able to run the whole app just by talking to you, eventually by voice and without looking at a \
screen: anything the app's UI can do, you can do, through app_api. That covers every area of \
the app: workers (create, edit, duplicate, archive, delete, their tasks and assignments), \
issues and pull requests, repos, workspaces, sessions and agent runs (start, follow up, stop, \
approvals, queue), plans, missions and briefs, settings and agent profiles, MCP servers, skills, \
tags, CI pipelines, GitHub, search, files and system status. If the user asks what you can do, \
say exactly that: everything they can do in fluke, by asking you, with a few concrete examples. \
Never describe yourself as limited to a couple of things.

Doing things (most requests):
- Act yourself: assign or reassign a task, create or edit a worker, change a setting, start or \
stop a run, report status, and so on.
- Find the endpoint and the body shape with app_api_reference (search a keyword such as \
\"workers\", \"reassign\", \"issues\"; an empty query lists every endpoint).
- Profiles (workers) and repos can be named instead of their id: in the path \
(/api/workers/Backend/tasks) and in worker_id, target_worker_id and repo_id of the body, the app \
swaps the name for the id. For anything else, resolve names to ids with a GET first. If a name \
matches more than one thing, ask with ask_user and short options.
- Make the call with app_api and confirm what changed in one short sentence. If it fails, \
read the error, fix the call and retry once before telling the user.
- Destructive or hard-to-undo calls (DELETE, archive, remove, merge, approve, stop, send...) are \
gated by the app, even when the user asked for them: app_api answers needs_confirmation and shows \
the user 'Sí' / 'Cancelar'. Pass a short summary in the user's words, say in one sentence what \
you are about to do and end your turn. When the user's next message confirms, call confirm_action \
with the token; if they say anything else, the action is cancelled.
- These never create brief items. Give the conversation a short title with set_mission.

New development work (a bug, a feature or a design change that needs code written) is the one \
case with its own flow: you do not build it yourself, you sit above the Analyst and turn it into \
a structured brief.

Brief flow:
- Split the request into items. Each item is a bug, a feature or a design change. Detect which \
registered repo it is about (list_repos) and set it with set_mission, together with a short \
mission title.
- Record every item and every fact the user gives you with upsert_item as soon as you learn it. \
The tool answers with what is still missing: the code, not you, decides when the brief is complete.
- Ask only for what is missing. Use ask_user with at most 3 questions per turn, each with short \
answer options the user can click; then end your turn and wait. Do not repeat the questions in \
your text reply.
- Every bug and feature has a \"tdd\" field: whether QA writes the tests before the code. When \
the item is testable logic, ask the user (options \"Con TDD\" / \"Sin TDD\") and record \"sí\" or \
\"no\". When test-first makes no sense (purely visual change, configuration, a bug that cannot \
be reproduced), record \"no aplica\" yourself without asking.
- You may read the code of the current repo (Read, Grep, Glob) to understand the request or \
propose likely files, but you never write code, edit files or run commands: development is \
the workers' job.
- When the brief is complete, give a 2-3 line summary and tell the user to review it and press \
\"Approve brief and send to the Analyst\". Approve it yourself (app_api) only when the user \
explicitly asks you to, and never create the issues yourself: that is the Analyst's job.
- Unblocking: when the user talks about a stuck issue (a coding agent waiting for an answer, a \
failed phase), call get_stuck_issues to see why it is stuck. If the agent asked a question, turn \
what the user says into a concrete answer (one of the agent's option keys, or a short text) and \
confirm it with the user through ask_user before calling answer_agent. Never answer the agent \
without that confirmation. For other blocks, explain them and point the user to the Destrabar \
button of the issue.
- Every message starts with a <fluke-context> block written by the app, not by the user. Its \
[APP CONTEXT] tells you the screen, repo and selection the user is looking at right now: use it \
to resolve references like \"this screen\", \"this task\" or \"this bug\". Its [STATUS] is the \
state of the app at that moment: answer \"how are we doing\" or \"what's running\" from it \
without calling tools. Call status_snapshot only if you need it fresher within the same turn. \
Never mention the block itself.
- Reply in the user's language. Be brief: short sentences that also work read aloud.";

/// Apertura y cierre del bloque de contexto de cada turno. La UI lo oculta.
pub const CONTEXT_OPEN: &str = "<fluke-context>";
pub const CONTEXT_CLOSE: &str = "</fluke-context>";

/// Lo estable de Fluke: instrucciones, guardia y soul. Va al system prompt
/// del CLI, que con el proceso persistente (J0.1) dura muchos turnos.
pub async fn system_prompt(pool: &Pool, mission: &Mission) -> Result<String, sqlx::Error> {
    let worker = ensure_orchestrator(pool).await?;
    let guard = if FlukeGuard::is_guard(pool, mission.id).await? {
        GUARD_PROMPT
    } else {
        ""
    };
    Ok(format!(
        "{SYSTEM_PROMPT}{guard}\n\n[DIRECTOR SOUL]\n{}",
        worker.soul
    ))
}

/// Lo que cambia en cada turno (pantalla y estado de la app): va al
/// principio del mensaje, dentro de `<fluke-context>`.
pub async fn turn_context(pool: &Pool, mission: &Mission) -> Result<String, sqlx::Error> {
    let ctx = mission
        .ui_context
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("unknown");
    let status = status_snapshot(pool).await?;
    Ok(format!(
        "{CONTEXT_OPEN}\n[APP CONTEXT]\n{ctx}\n\n[STATUS]\n{status}\n{CONTEXT_CLOSE}"
    ))
}

// ---------------------------------------------------------------------------
// Conversación de guardia (J0.3): los eventos del bus llegan acá
// ---------------------------------------------------------------------------

/// Encabezado de un lote de eventos. Lo que empieza así no es el usuario.
pub const EVENTS_PREFIX: &str = "[EVENTS]";
/// Respuesta de Fluke cuando nada amerita avisar; la UI no la muestra.
pub const SILENT_REPLY: &str = "SILENT";

const GUARD_PROMPT: &str = "

This is your standing conversation, the first tab, always open. Besides the user, the app writes \
here: a message whose text (after the context block) starts with [EVENTS] lists what just happened (tasks, reviews, PRs and CI, \
missions, milestone runs). It is not the user talking. For an [EVENTS] message:
- If something deserves the user's attention (a failure, a question from a worker, a PR ready to \
merge, red CI, a run that stopped), tell them in one or two short sentences: what happened and \
what you suggest. Do not list every event.
- Otherwise reply with exactly SILENT and nothing else.
- Do not act on events by yourself; at most suggest. Never call tools for an [EVENTS] message \
unless you need a detail to explain it.
This conversation has no brief: for new development work, start a mission (app_api POST \
/api/missions with the repo_id) and tell the user to continue there.";

/// El lote de eventos que se le manda a la guardia, una línea por evento.
pub fn events_message(events: &[db::models::fluke_event::FlukeEvent]) -> String {
    let mut out = String::from(EVENTS_PREFIX);
    for e in events {
        let time = e.created_at.get(11..16).unwrap_or(&e.created_at);
        let mut line = format!("\n- {time} {} [{}]", e.kind, e.severity);
        if let Some(n) = e.issue_number {
            line.push_str(&format!(" issue #{n}"));
        }
        if let Some(n) = e.pr_number {
            line.push_str(&format!(" PR #{n}"));
        }
        if let Some(t) = e.title.as_deref().filter(|t| !t.is_empty()) {
            line.push_str(&format!(" \"{t}\""));
        }
        if let Some(d) = e.detail.as_deref().filter(|d| !d.is_empty()) {
            line.push_str(&format!(": {d}"));
        }
        out.push_str(&line);
    }
    out
}

// ---------------------------------------------------------------------------
// Estado de la app (J0.4): lo que Fluke sabe sin preguntar
// ---------------------------------------------------------------------------

const SNAPSHOT_LIST_MAX: i64 = 6;

/// Resumen del estado actual, armado por el código en cada turno: qué corre,
/// qué está trancado, qué espera al usuario y cómo están los PRs. Así "¿cómo
/// vamos?" no necesita herramientas. Sale de las tablas (estado), no del bus
/// de eventos (deltas).
pub async fn status_snapshot(pool: &Pool) -> Result<String, sqlx::Error> {
    use sqlx::Row;

    let counts = sqlx::query(
        "SELECT status, COUNT(*) AS n FROM worker_tasks \
          WHERE status IN ('queued', 'in_progress', 'waiting_user', 'in_review', 'approved') \
          GROUP BY status",
    )
    .fetch_all(pool)
    .await?;
    let count = |s: &str| -> i64 {
        counts
            .iter()
            .find(|r| r.get::<String, _>("status") == s)
            .map(|r| r.get::<i64, _>("n"))
            .unwrap_or(0)
    };
    let failed_24h: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_tasks WHERE status = 'failed' \
           AND completed_at > datetime('now', '-1 day')",
    )
    .fetch_one(pool)
    .await?;

    let mut out = format!(
        "Tasks: {} running, {} queued, {} in review, {} approved, {} waiting for the user, {} failed in the last 24 h.",
        count("in_progress"),
        count("queued"),
        count("in_review"),
        count("approved"),
        count("waiting_user"),
        failed_24h,
    );

    let task_line = |r: &sqlx::sqlite::SqliteRow, extra: &str| {
        let issue = r
            .get::<Option<i64>, _>("issue_number")
            .map(|n| format!("#{n} "))
            .unwrap_or_default();
        let title = r.get::<String, _>("title");
        format!(
            "\n- {}{} ({}){extra}",
            issue,
            title.trim_start_matches(issue.as_str()).trim(),
            r.get::<Option<String>, _>("role").unwrap_or_default(),
        )
    };

    let running = sqlx::query(
        "SELECT t.issue_number, t.title, w.role FROM worker_tasks t \
           LEFT JOIN workers w ON w.id = t.worker_id \
          WHERE t.status = 'in_progress' ORDER BY t.created_at LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?;
    if !running.is_empty() {
        out.push_str("\nRunning:");
        for r in &running {
            out.push_str(&task_line(r, ""));
        }
    }

    let mut waiting = Vec::new();
    for r in sqlx::query(
        "SELECT t.issue_number, t.title, w.role, t.pending_question FROM worker_tasks t \
           LEFT JOIN workers w ON w.id = t.worker_id \
          WHERE t.status = 'waiting_user' ORDER BY t.created_at LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?
    {
        let question = r
            .get::<Option<String>, _>("pending_question")
            .map(|q| format!(": asks {}", truncate(q, 200)))
            .unwrap_or_default();
        waiting.push(task_line(&r, &question));
    }
    for r in sqlx::query(
        "SELECT title, status FROM missions \
          WHERE status = 'brief_ready' OR (status <> 'closed' AND pending_questions <> '[]') \
          ORDER BY updated_at DESC LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?
    {
        let what = if r.get::<String, _>("status") == mission::STATUS_BRIEF_READY {
            "brief ready to approve"
        } else {
            "has open questions for the user"
        };
        waiting.push(format!(
            "\n- mission \"{}\": {what}",
            r.get::<String, _>("title")
        ));
    }
    for r in sqlx::query(
        "SELECT milestone, status, waiting_reason FROM milestone_runs \
          WHERE status NOT IN ('running', 'done') ORDER BY updated_at DESC LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?
    {
        waiting.push(format!(
            "\n- milestone run \"{}\" {}{}",
            r.get::<String, _>("milestone"),
            r.get::<String, _>("status"),
            r.get::<Option<String>, _>("waiting_reason")
                .map(|w| format!(": {w}"))
                .unwrap_or_default(),
        ));
    }
    if !waiting.is_empty() {
        out.push_str("\nWaiting for the user:");
        out.extend(waiting);
    }

    let failed = sqlx::query(
        "SELECT t.issue_number, t.title, w.role, t.failure_kind FROM worker_tasks t \
           LEFT JOIN workers w ON w.id = t.worker_id \
          WHERE t.status = 'failed' AND t.completed_at > datetime('now', '-1 day') \
          ORDER BY t.completed_at DESC LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?;
    if !failed.is_empty() {
        out.push_str("\nFailed (24 h):");
        for r in &failed {
            let kind = r
                .get::<Option<String>, _>("failure_kind")
                .map(|k| format!(": {k}"))
                .unwrap_or_default();
            out.push_str(&task_line(r, &kind));
        }
    }

    let prs = sqlx::query(
        "SELECT pr_number, pr_ci_status, pr_mergeable FROM pull_requests \
          WHERE pr_status = 'open' ORDER BY pr_number DESC LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX * 2)
    .fetch_all(pool)
    .await?;
    if prs.is_empty() {
        out.push_str("\nOpen PRs: none.");
    } else {
        out.push_str("\nOpen PRs:");
        for r in &prs {
            out.push_str(&format!(
                " #{} (CI {}, mergeable {});",
                r.get::<i64, _>("pr_number"),
                r.get::<Option<String>, _>("pr_ci_status")
                    .unwrap_or_else(|| "none".into()),
                r.get::<Option<String>, _>("pr_mergeable")
                    .unwrap_or_else(|| "unknown".into()),
            ));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Herramientas del MCP del Director
// ---------------------------------------------------------------------------

pub fn tool_definitions() -> Value {
    let kinds = json!(KINDS);
    json!([
        {
            "name": "list_repos",
            "description": "List the repos registered in fluke (id and name).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_workers",
            "description": "List the workers of the team with their role and model.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "set_mission",
            "description": "Set the mission title and/or its repo (repo id or name from list_repos). Returns the brief status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "repo": { "type": "string" }
                }
            }
        },
        {
            "name": "upsert_item",
            "description": "Create an item of the brief (omit item_id) or update one. Fields are merged with the existing ones; an empty string clears a field. Fields per kind - bug: symptom, steps, acceptance; feature: goal, scope, acceptance; design: goal, scope (include mobile), reference (optional). Returns the brief status with what is still missing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": { "type": "string" },
                    "kind": { "type": "string", "enum": kinds },
                    "title": { "type": "string" },
                    "fields": { "type": "object", "additionalProperties": { "type": "string" } }
                },
                "required": ["kind"]
            }
        },
        {
            "name": "remove_item",
            "description": "Remove an item from the brief.",
            "inputSchema": {
                "type": "object",
                "properties": { "item_id": { "type": "string" } },
                "required": ["item_id"]
            }
        },
        {
            "name": "get_brief",
            "description": "Return the current brief as markdown, its items with ids, and what is missing.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_stuck_issues",
            "description": "List the open issues of the mission's repo that need a person: why each one is stuck (question, credential, failed, review_cap, no_progress), the stuck phase and, for a question, the agent's question with its options.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "answer_agent",
            "description": "Answer, on the user's behalf, the question a coding agent is waiting on in an issue. Only after the user confirmed this exact answer in this conversation. The answer is one of the agent's option keys or a short free text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": { "type": "integer" },
                    "answer": { "type": "string" }
                },
                "required": ["issue_number", "answer"]
            }
        },
        {
            "name": "status_snapshot",
            "description": "Fresh summary of the app right now: running, queued and failed tasks, what waits for the user (worker questions, briefs to approve, paused milestone runs), open PRs and their CI. The same summary comes in [STATUS] at the start of each turn; call this only to refresh it mid-turn.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "app_api_reference",
            "description": "Search the fluke app's API: the frontend API client (every call the UI makes, with method, path and body type) and the shared request/response types. An empty query lists every endpoint path. Use it before app_api to find the endpoint and the exact body shape.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "Keyword, endpoint path or type name, case-insensitive. Empty: list every endpoint." } }
            }
        },
        {
            "name": "app_api",
            "description": "Call any endpoint of the fluke app's local API as the user, exactly like the UI does. Returns the HTTP status and the JSON response (responses are wrapped as {success, data, message}). Destructive calls (DELETE, archive, merge, approve, stop, send...) are not executed: the app asks the user to confirm and answers needs_confirmation with a token for confirm_action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                    "path": { "type": "string", "description": "Starts with /api/, query string included, e.g. /api/workers or /api/workers/{id}." },
                    "body": { "description": "JSON body for POST/PUT/PATCH." },
                    "summary": { "type": "string", "description": "For destructive calls: what it does in the user's words and language, shown in the confirmation, e.g. 'borrar el perfil QA'." }
                },
                "required": ["method", "path"]
            }
        },
        {
            "name": "confirm_action",
            "description": "Execute a destructive app_api call the user just confirmed. Only works after the user's own message confirmed it; otherwise it fails.",
            "inputSchema": {
                "type": "object",
                "properties": { "token": { "type": "string" } },
                "required": ["token"]
            }
        },
        {
            "name": "ask_user",
            "description": "Ask the user up to 3 questions, each with up to 4 short answer options shown as clickable chips. After calling it, end your turn.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "maxItems": MAX_QUESTIONS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string" },
                                "options": { "type": "array", "items": { "type": "string" } }
                            },
                            "required": ["question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }
    ])
}

#[derive(Deserialize)]
struct UpsertArgs {
    item_id: Option<Uuid>,
    kind: String,
    title: Option<String>,
    #[serde(default)]
    fields: BTreeMap<String, String>,
}

fn status_text(d: &MissionDetail) -> String {
    let items: Vec<Value> = d
        .items
        .iter()
        .enumerate()
        .map(|(i, v)| {
            json!({
                "n": i + 1,
                "item_id": v.item.id,
                "kind": v.item.kind,
                "title": v.item.title,
                "missing": v.missing().collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "title": d.mission.title,
        "repo": d.repo_name,
        "items": items,
        "missing": d.missing,
        "complete": d.complete,
    })
    .to_string()
}

async fn resolve_repo(pool: &Pool, value: &str) -> Result<Repo, String> {
    let repos = Repo::list_all(pool)
        .await
        .map_err(|e| format!("internal error: {e}"))?;
    let needle = value.trim();
    repos
        .into_iter()
        .find(|r| {
            r.id.to_string() == needle
                || r.name.eq_ignore_ascii_case(needle)
                || r.display_name.eq_ignore_ascii_case(needle)
        })
        .ok_or_else(|| format!("unknown repo '{needle}': use an id or name from list_repos"))
}

/// Endpoints del cliente (líneas con `/api/`), o los fragmentos de cliente y
/// tipos que mencionan `query`, con unas líneas de contexto.
fn api_reference(query: &str) -> String {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        let lines: Vec<&str> = API_CLIENT
            .lines()
            .filter(|l| l.contains("/api/"))
            .map(str::trim)
            .collect();
        return truncate(lines.join("\n"), API_REFERENCE_MAX);
    }
    let mut out = String::new();
    for (name, text) in [("api.ts", API_CLIENT), ("types.ts", API_TYPES)] {
        let lines: Vec<&str> = text.lines().collect();
        let mut shown_until = 0;
        for (i, line) in lines.iter().enumerate() {
            if i < shown_until || !line.to_lowercase().contains(&query) {
                continue;
            }
            let from = i.saturating_sub(4).max(shown_until);
            shown_until = (i + 12).min(lines.len());
            out.push_str(&format!("--- {name}:{}\n", from + 1));
            out.push_str(&lines[from..shown_until].join("\n"));
            out.push('\n');
            if out.len() > API_REFERENCE_MAX {
                return truncate(out, API_REFERENCE_MAX);
            }
        }
    }
    if out.is_empty() {
        format!("nothing matches '{query}': try another keyword or an empty query")
    } else {
        out
    }
}

fn truncate(mut s: String, max: usize) -> String {
    if s.len() > max {
        let cut = (0..=max)
            .rev()
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(0);
        s.truncate(cut);
        s.push_str("\n[truncated: narrow the query or the request]");
    }
    s
}

/// Método y ruta de una llamada de `app_api`, validados.
fn api_call(args: &Value) -> Result<(reqwest::Method, String), String> {
    let method = args.get("method").and_then(Value::as_str).unwrap_or("GET");
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("invalid method '{method}'"))?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing path")?;
    if !path.starts_with("/api/") || path.contains("..") {
        return Err("path must start with /api/".into());
    }
    // Its own MCP endpoint: no use, and a loop if it ever called itself.
    if path.starts_with("/api/director-mcp") {
        return Err("that endpoint is not available to you".into());
    }
    Ok((method, path.to_string()))
}

/// Campos del body que la UI llena con ids y que Fluke puede dar por nombre.
const NAME_KEYS: &[(&str, &str)] = &[
    ("worker_id", "workers"),
    ("target_worker_id", "workers"),
    ("repo_id", "repos"),
];

/// Nombres de perfiles y repos (en la ruta o en el body) cambiados por su id,
/// así Fluke no necesita un GET previo para cada orden (J0.6). Un tramo de
/// ruta que no coincide con ningún nombre queda como está (puede ser una
/// ruta literal); un campo del body que no coincide es un error.
async fn resolve_names(pool: &Pool, args: &Value) -> Result<Value, String> {
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    let mut names: Vec<(&str, String, String)> = Vec::new();
    for w in Worker::list_all(pool).await.map_err(db_err)? {
        names.push(("workers", w.name.to_lowercase(), w.id.to_string()));
    }
    for r in Repo::list_all(pool).await.map_err(db_err)? {
        names.push(("repos", r.name.to_lowercase(), r.id.to_string()));
        names.push(("repos", r.display_name.to_lowercase(), r.id.to_string()));
    }
    let lookup = |collection: &str, value: &str| -> Result<Option<String>, String> {
        if Uuid::parse_str(value).is_ok() {
            return Ok(None);
        }
        let needle = value.trim().to_lowercase();
        let mut ids: Vec<&String> = names
            .iter()
            .filter(|(c, n, _)| *c == collection && *n == needle)
            .map(|(_, _, id)| id)
            .collect();
        ids.dedup();
        match ids.as_slice() {
            [] => Ok(None),
            [id] => Ok(Some((*id).clone())),
            _ => Err(format!(
                "'{value}' matches more than one in {collection}: use the id"
            )),
        }
    };

    let mut args = args.clone();
    if let Some(path) = args.get("path").and_then(Value::as_str) {
        let (route, query) = path.split_once('?').map_or((path, None), |(r, q)| (r, Some(q)));
        let mut parts: Vec<String> = route.split('/').map(str::to_string).collect();
        for i in 1..parts.len() {
            let collection = parts[i - 1].clone();
            if (collection == "workers" || collection == "repos") && !parts[i].is_empty() {
                let decoded = parts[i].replace("%20", " ");
                if let Some(id) = lookup(&collection, &decoded)? {
                    parts[i] = id;
                }
            }
        }
        let mut path = parts.join("/");
        if let Some(q) = query {
            path = format!("{path}?{q}");
        }
        args["path"] = Value::String(path);
    }
    if let Some(body) = args.get_mut("body").and_then(Value::as_object_mut) {
        for (key, collection) in NAME_KEYS {
            if let Some(Value::String(value)) = body.get(*key).cloned() {
                if Uuid::parse_str(&value).is_err() {
                    let id = lookup(collection, &value)?.ok_or_else(|| {
                        format!("unknown {} '{value}' in {key}", &collection[..collection.len() - 1])
                    })?;
                    body.insert((*key).to_string(), Value::String(id));
                }
            }
        }
    }
    Ok(args)
}

/// Llama al backend local como lo haría la UI (mismo proceso, loopback).
async fn app_api(args: &Value) -> Result<String, String> {
    let (method, path) = api_call(args)?;
    // The server address is only exposed through the MCP URL helper.
    let base = utils::plan_mcp::director_url_for_session("")
        .and_then(|url| url.split("/api/").next().map(str::to_string))
        .ok_or("the app's API address is not known yet")?;

    let mut request = reqwest::Client::new()
        .request(method, format!("{base}{path}"))
        .timeout(std::time::Duration::from_secs(60));
    if let Some(body) = args.get("body").filter(|b| !b.is_null()) {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    Ok(truncate(format!("HTTP {status}\n{text}"), API_RESPONSE_MAX))
}

/// Compuerta de acciones peligrosas (J0.5): la decide el código, no el
/// modelo. `app_api` no ejecuta un DELETE ni una ruta peligrosa: la deja
/// pendiente y le muestra al usuario chips "Sí, …" / "Cancelar". Solo un
/// mensaje del usuario que empiece con "sí" la habilita; cualquier otro la
/// cancela. Recién entonces `confirm_action` la ejecuta. En memoria a
/// propósito: un reinicio cancela lo pendiente.
mod confirmations {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };

    use serde_json::Value;
    use uuid::Uuid;

    /// Tramos de ruta que hacen peligrosa una llamada que no es GET.
    const DANGEROUS: &[&str] = &[
        "archive", "merge", "approve", "delete", "remove", "reset", "close", "push", "send",
        "revert", "stop", "cancel", "force",
    ];

    pub struct Pending {
        pub token: Uuid,
        pub args: Value,
        pub approved: bool,
    }

    fn store() -> &'static Mutex<HashMap<Uuid, Pending>> {
        static STORE: OnceLock<Mutex<HashMap<Uuid, Pending>>> = OnceLock::new();
        STORE.get_or_init(Default::default)
    }

    pub fn is_dangerous(method: &reqwest::Method, path: &str) -> bool {
        if *method == reqwest::Method::GET {
            return false;
        }
        if *method == reqwest::Method::DELETE {
            return true;
        }
        let path = path.split('?').next().unwrap_or(path).to_lowercase();
        path.split(['/', '-', '_'])
            .any(|part| DANGEROUS.contains(&part))
    }

    /// Deja la llamada pendiente para la misión (reemplaza la anterior).
    pub fn hold(mission_id: Uuid, args: Value) -> Uuid {
        let token = Uuid::new_v4();
        if let Ok(mut map) = store().lock() {
            map.insert(
                mission_id,
                Pending {
                    token,
                    args,
                    approved: false,
                },
            );
        }
        token
    }

    pub fn on_user_message(mission_id: Uuid, prompt: &str) {
        let Ok(mut map) = store().lock() else { return };
        let yes = {
            let p = prompt.trim_start().to_lowercase();
            ["sí", "si", "yes", "dale", "ok"]
                .iter()
                .any(|w| p == *w || p.starts_with(&format!("{w},")) || p.starts_with(&format!("{w} ")))
        };
        match map.get_mut(&mission_id) {
            Some(pending) if yes => pending.approved = true,
            Some(_) => {
                map.remove(&mission_id);
            }
            None => {}
        }
    }

    /// La llamada aprobada con ese token, una sola vez.
    pub fn take_approved(mission_id: Uuid, token: Uuid) -> Result<Value, &'static str> {
        let mut map = store().lock().map_err(|_| "internal error")?;
        match map.get(&mission_id) {
            Some(p) if p.token == token && p.approved => {
                Ok(map.remove(&mission_id).map(|p| p.args).unwrap_or_default())
            }
            Some(p) if p.token == token => Err(
                "the user has not confirmed yet: the chips are shown, end your turn and wait",
            ),
            _ => Err("no pending action with that token (the user cancelled it or it expired)"),
        }
    }
}

/// Texto corto de la acción para el chip: "DELETE /api/workers/…".
fn action_label(method: &reqwest::Method, path: &str) -> String {
    let path = path.split('?').next().unwrap_or(path);
    let short: Vec<&str> = path
        .trim_start_matches("/api/")
        .split('/')
        .filter(|s| Uuid::parse_str(s).is_err())
        .collect();
    format!("{method} {}", short.join(" "))
}

/// Ejecuta una herramienta. `Err` vuelve al agente como resultado con
/// `isError`.
pub async fn call_tool(
    pool: &Pool,
    session_id: Uuid,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    let mission = Mission::find_by_session_id(pool, session_id)
        .await
        .map_err(db_err)?
        .ok_or("this session has no mission")?;
    let id = mission.id;

    if matches!(name, "set_mission" | "upsert_item" | "remove_item")
        && FlukeGuard::is_guard(pool, id).await.map_err(db_err)?
    {
        return Err("this is your standing conversation, it has no brief: for new development \
                    work start a mission with app_api (POST /api/missions with the \
                    repo_id) and tell the user to continue there"
            .into());
    }

    match name {
        "list_repos" => {
            let repos = Repo::list_all(pool).await.map_err(db_err)?;
            let out: Vec<Value> = repos
                .iter()
                .map(|r| json!({ "id": r.id, "name": r.display_name }))
                .collect();
            Ok(Value::Array(out).to_string())
        }
        "list_workers" => {
            let workers = Worker::list_all(pool).await.map_err(db_err)?;
            let out: Vec<Value> = workers
                .iter()
                .filter(|w| w.role != ROLE_ORCHESTRATOR)
                .map(|w| json!({ "name": w.name, "role": w.role, "model": w.model }))
                .collect();
            Ok(Value::Array(out).to_string())
        }
        "set_mission" => {
            if let Some(title) = args.get("title").and_then(Value::as_str) {
                Mission::set_title(pool, id, title.trim())
                    .await
                    .map_err(db_err)?;
            }
            if let Some(repo) = args.get("repo").and_then(Value::as_str) {
                let repo = resolve_repo(pool, repo).await?;
                Mission::set_repo(pool, id, Some(repo.id))
                    .await
                    .map_err(db_err)?;
            }
            let d = refresh_status(pool, id).await.map_err(db_err)?;
            Ok(status_text(&d))
        }
        "upsert_item" => {
            let a: UpsertArgs = serde_json::from_value(args.clone())
                .map_err(|e| format!("invalid arguments: {e}"))?;
            if !KINDS.contains(&a.kind.as_str()) {
                return Err(format!("kind must be one of {KINDS:?}"));
            }
            let allowed: Vec<&str> = kind_fields(&a.kind).iter().map(|f| f.0).collect();
            if let Some(bad) = a.fields.keys().find(|k| !allowed.contains(&k.as_str())) {
                return Err(format!(
                    "unknown field '{bad}' for a {}: use {allowed:?}",
                    a.kind
                ));
            }
            Mission::upsert_item(pool, id, a.item_id, &a.kind, a.title.as_deref(), &a.fields)
                .await
                .map_err(|e| match e {
                    sqlx::Error::RowNotFound => "unknown item_id".to_string(),
                    e => db_err(e),
                })?;
            reopen_if_sent(pool, &mission).await.map_err(db_err)?;
            let d = refresh_status(pool, id).await.map_err(db_err)?;
            Ok(status_text(&d))
        }
        "remove_item" => {
            let item_id = args
                .get("item_id")
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or("missing item_id")?;
            if !Mission::remove_item(pool, id, item_id)
                .await
                .map_err(db_err)?
            {
                return Err("unknown item_id".into());
            }
            reopen_if_sent(pool, &mission).await.map_err(db_err)?;
            let d = refresh_status(pool, id).await.map_err(db_err)?;
            Ok(status_text(&d))
        }
        "get_brief" => {
            let d = refresh_status(pool, id).await.map_err(db_err)?;
            Ok(format!("{}\n\n{}", render_markdown(&d), status_text(&d)))
        }
        "ask_user" => {
            let questions: Vec<PendingQuestion> =
                serde_json::from_value(args.get("questions").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("invalid questions: {e}"))?;
            if questions.is_empty() {
                return Err("ask at least one question".into());
            }
            if questions.len() > MAX_QUESTIONS {
                return Err(format!("ask at most {MAX_QUESTIONS} questions per turn"));
            }
            let questions: Vec<PendingQuestion> = questions
                .into_iter()
                .map(|mut q| {
                    q.options.retain(|o| !o.trim().is_empty());
                    q.options.truncate(MAX_OPTIONS);
                    q
                })
                .collect();
            Mission::set_pending_questions(pool, id, &questions)
                .await
                .map_err(db_err)?;
            Ok("Questions shown to the user. End your turn now and wait for the answer.".into())
        }
        "status_snapshot" => status_snapshot(pool).await.map_err(db_err),
        "app_api_reference" => Ok(api_reference(
            args.get("query").and_then(Value::as_str).unwrap_or(""),
        )),
        "app_api" => {
            let args = &resolve_names(pool, args).await?;
            let (method, path) = api_call(args)?;
            if !confirmations::is_dangerous(&method, &path) {
                return app_api(args).await;
            }
            let label = action_label(&method, &path);
            let summary = args
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| label.clone());
            let token = confirmations::hold(id, args.clone());
            Mission::set_pending_questions(
                pool,
                id,
                &[PendingQuestion {
                    question: format!("¿Confirmás? {summary}"),
                    options: vec![format!("Sí, {summary}"), "Cancelar".into()],
                }],
            )
            .await
            .map_err(db_err)?;
            Ok(format!(
                "needs_confirmation: '{label}' was NOT executed. The user now sees a confirmation \
                 with 'Sí' / 'Cancelar'. Say in one sentence what you are about to do and end your \
                 turn. If the user's next message confirms, call confirm_action with token {token}."
            ))
        }
        "confirm_action" => {
            let token = args
                .get("token")
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or("missing token")?;
            let held = confirmations::take_approved(id, token)?;
            app_api(&held).await
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_snapshot_reports_running_waiting_and_prs() {
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
        let dev = Uuid::new_v4();
        sqlx::query("INSERT INTO workers (id, name, emoji, soul, role) VALUES (?, 'Dev', '', '', 'developer')")
            .bind(dev)
            .execute(&pool)
            .await
            .unwrap();
        for (n, status, question) in [
            (664, "in_progress", None),
            (663, "waiting_user", Some("¿Qué hacemos con los issues sin milestone?")),
        ] {
            sqlx::query(
                "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, issue_number, status, pending_question) \
                 VALUES (?, ?, ?, 1, ?, 'p', ?, ?, ?)",
            )
            .bind(Uuid::new_v4())
            .bind(dev)
            .bind(Uuid::new_v4())
            .bind(format!("#{n} Vista Plan"))
            .bind(n)
            .bind(status)
            .bind(question)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO pull_requests (id, repo_id, pr_url, pr_number, pr_status, target_branch_name, pr_ci_status) \
             VALUES ('pr1', ?, 'u', 675, 'open', 'main', 'passing')",
        )
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();

        let s = status_snapshot(&pool).await.unwrap();
        assert!(s.starts_with("Tasks: 1 running, 0 queued"), "{s}");
        assert!(s.contains("Running:\n- #664 Vista Plan (developer)"), "{s}");
        assert!(s.contains("- #663 Vista Plan (developer): asks"), "{s}");
        assert!(s.contains("#675 (CI passing"), "{s}");
    }

    #[tokio::test]
    async fn editing_a_sent_brief_asks_for_approval_again() {
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
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        let m = Mission::create(&pool, session, Some(Uuid::new_v4()))
            .await
            .unwrap();
        Mission::set_title(&pool, m.id, "Advanced settings")
            .await
            .unwrap();
        Mission::set_status(&pool, m.id, mission::STATUS_PLANNING)
            .await
            .unwrap();

        let args = json!({ "kind": "feature", "title": "Implementar", "fields": {
            "goal": "g", "scope": "s", "acceptance": "a", "tdd": "sí" } });
        call_tool(&pool, session, "upsert_item", &args)
            .await
            .unwrap();

        let m = Mission::find_by_id(&pool, m.id).await.unwrap().unwrap();
        assert_eq!(m.status, mission::STATUS_BRIEF_READY);
    }

    #[tokio::test]
    async fn names_become_ids_in_path_and_body() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let backend = Uuid::new_v4();
        sqlx::query("INSERT INTO workers (id, name, emoji, soul, role) VALUES (?, 'Backend', '', '', 'developer')")
            .bind(backend)
            .execute(&pool)
            .await
            .unwrap();
        let repo = Uuid::new_v4();
        sqlx::query("INSERT INTO repos (id, path, name, display_name) VALUES (?, '/r/fluke', 'fluke', 'Fluke app')")
            .bind(repo)
            .execute(&pool)
            .await
            .unwrap();

        let out = resolve_names(
            &pool,
            &json!({
                "method": "POST",
                "path": "/api/workers/backend/tasks?x=1",
                "body": { "repo_id": "Fluke app", "target_worker_id": backend.to_string() }
            }),
        )
        .await
        .unwrap();
        assert_eq!(out["path"], format!("/api/workers/{backend}/tasks?x=1"));
        assert_eq!(out["body"]["repo_id"], repo.to_string());
        assert_eq!(out["body"]["target_worker_id"], backend.to_string());

        // A literal route segment stays; an unknown name in the body is an error.
        let out = resolve_names(&pool, &json!({ "path": "/api/workers/archived" }))
            .await
            .unwrap();
        assert_eq!(out["path"], "/api/workers/archived");
        let err = resolve_names(&pool, &json!({ "path": "/api/x", "body": { "worker_id": "Nadie" } }))
            .await
            .unwrap_err();
        assert!(err.contains("unknown worker 'Nadie'"), "{err}");
    }

    #[test]
    fn events_message_lists_one_line_per_event() {
        use db::models::fluke_event::FlukeEvent;
        let event = |kind: &str, severity: &str, issue, pr, title: Option<&str>, detail: Option<&str>| {
            FlukeEvent {
                id: 1,
                created_at: "2026-10-03 09:31:07.123".into(),
                kind: kind.into(),
                severity: severity.into(),
                subject_id: None,
                repo_id: None,
                issue_number: issue,
                pr_number: pr,
                title: title.map(str::to_string),
                detail: detail.map(str::to_string),
            }
        };
        let msg = events_message(&[
            event("task.failed", "alert", Some(710), None, Some("#710 Volver"), Some("developer · infra: 404")),
            event("pr.ci_failing", "alert", None, Some(725), None, Some("")),
        ]);
        assert_eq!(
            msg,
            "[EVENTS]\n- 09:31 task.failed [alert] issue #710 \"#710 Volver\": developer · infra: 404\n- 09:31 pr.ci_failing [alert] PR #725"
        );
        assert!(msg.starts_with(EVENTS_PREFIX));
    }

    #[test]
    fn dangerous_calls_need_the_users_own_yes() {
        use reqwest::Method;
        assert!(confirmations::is_dangerous(&Method::DELETE, "/api/workers/x"));
        assert!(confirmations::is_dangerous(&Method::POST, "/api/missions/x/approve-brief"));
        assert!(confirmations::is_dangerous(&Method::POST, "/api/workspaces/x/merge?force=1"));
        assert!(!confirmations::is_dangerous(&Method::GET, "/api/workers/x/archive"));
        assert!(!confirmations::is_dangerous(&Method::POST, "/api/workers/x/tasks"));
        assert!(!confirmations::is_dangerous(&Method::PATCH, "/api/workers/x"));

        let mission = Uuid::new_v4();
        let token = confirmations::hold(mission, json!({"method": "DELETE", "path": "/api/workers/x"}));
        // The model cannot confirm by itself.
        assert!(confirmations::take_approved(mission, token).is_err());
        confirmations::on_user_message(mission, "Sí, borrar el perfil QA");
        assert!(confirmations::take_approved(mission, Uuid::new_v4()).is_err());
        assert_eq!(
            confirmations::take_approved(mission, token).unwrap()["method"],
            "DELETE"
        );
        // Only once.
        assert!(confirmations::take_approved(mission, token).is_err());

        // Anything but a yes cancels.
        let token = confirmations::hold(mission, json!({}));
        confirmations::on_user_message(mission, "sigo pensando");
        confirmations::on_user_message(mission, "sí");
        assert!(confirmations::take_approved(mission, token).is_err());

        assert_eq!(
            action_label(&Method::DELETE, "/api/workers/3f6c1b4e-8d2a-4c1e-9f0a-1b2c3d4e5f60?x=1"),
            "DELETE workers"
        );
    }

    #[test]
    fn api_reference_finds_endpoints_and_types() {
        assert!(api_reference("").contains("/api/workers"));
        let hit = api_reference("ReassignWorkerTaskRequest");
        assert!(hit.contains("--- api.ts:") && hit.contains("reassign"));
        assert!(api_reference("zz-no-such-thing").starts_with("nothing matches"));
        assert!(truncate("ñandú".repeat(10), 7).starts_with("ñand"));
    }

    fn mission(title: &str, repo: bool) -> Mission {
        Mission {
            id: Uuid::new_v4(),
            title: title.into(),
            status: "clarifying".into(),
            autonomy: "brief_pr".into(),
            repo_id: repo.then(Uuid::new_v4),
            session_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            pending_questions: vec![],
            ui_context: None,
            analyst_task_id: None,
            cost_cap_usd: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn item(kind: &str, fields: &[(&str, &str)]) -> MissionItemView {
        item_view(MissionItem {
            id: Uuid::new_v4(),
            mission_id: Uuid::new_v4(),
            position: 1,
            kind: kind.into(),
            title: "t".into(),
            fields: fields
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            worker_id: None,
            model: None,
            route_reason: None,
        })
    }

    #[test]
    fn brief_is_complete_only_when_code_says_so() {
        let empty = missing(&mission("", false), &[]);
        assert_eq!(empty, vec!["title", "repo", "items"]);

        let bug = item("bug", &[("symptom", "crashes"), ("steps", "  ")]);
        assert_eq!(
            missing(&mission("Taller", true), &[bug]),
            vec!["item:1:steps", "item:1:acceptance", "item:1:tdd"]
        );

        // TDD has to be decided (#688): "sí", "no" or "no aplica".
        let feature = item(
            "feature",
            &[
                ("goal", "g"),
                ("scope", "s"),
                ("acceptance", "a"),
                ("tdd", "no aplica"),
            ],
        );
        assert!(missing(&mission("Taller", true), &[feature]).is_empty());

        // reference is optional for design
        let design = item("design", &[("goal", "g"), ("scope", "mobile too")]);
        assert!(missing(&mission("Taller", true), &[design]).is_empty());
    }
}
