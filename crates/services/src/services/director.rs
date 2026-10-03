//! Director (en la UI, "Fluke"): agente orquestador global.
//!
//! Conversa con el user en una sesión por misión, separa el pedido en ítems
//! (bug / feature / diseño) y los registra en un brief estructurado por su
//! MCP (`/api/director-mcp/{session_id}`). Qué campos son obligatorios y
//! cuándo el brief está completo lo decide este módulo, nunca el modelo. El
//! traspaso al Analista (G1) es un botón del user, no una herramienta.

use std::collections::BTreeMap;

use db::models::{
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
    format!(
        "Brief de la misión \"{title}\" (versión {version}), aprobado por el user.\n\n\
         {md}\n---\n\
         Partí cada ítem del brief en issues chicos y asignables. En el cuerpo de cada \
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

/// El user respondió: las preguntas pendientes quedan contestadas y una
/// misión nueva pasa a `clarifying`.
pub async fn on_user_message(pool: &Pool, mission: &Mission) -> Result<(), sqlx::Error> {
    if !mission.pending_questions.is_empty() {
        Mission::set_pending_questions(pool, mission.id, &[]).await?;
    }
    if mission.status == mission::STATUS_DRAFT {
        Mission::set_status(pool, mission.id, mission::STATUS_CLARIFYING).await?;
    }
    Ok(())
}

const SYSTEM_PROMPT: &str = "\
You are Fluke, the director agent of the fluke app (a desktop app where a team of AI workers \
- developers, analysts, reviewers, designers - builds software). You sit above the Analyst: \
you talk with the user until the request is fully understood and recorded as a structured brief.

How you work:
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
propose likely files, but you never write code, edit files or run commands.
- When the brief is complete, give a 2-3 line summary and tell the user to review it and press \
\"Approve brief and send to the Analyst\". You never send it yourself and never create issues.
- [APP CONTEXT] below tells you the screen, repo and selection the user is looking at right now. \
Use it to resolve references like \"this screen\" or \"this bug\".
- Reply in the user's language. Be brief.";

/// Se arma en cada turno (cada mensaje relanza el CLI), así lleva el soul y
/// el contexto de la app vigentes.
pub async fn system_prompt(pool: &Pool, mission: &Mission) -> Result<String, sqlx::Error> {
    let worker = ensure_orchestrator(pool).await?;
    let ctx = mission
        .ui_context
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("unknown");
    Ok(format!(
        "{SYSTEM_PROMPT}\n\n[DIRECTOR SOUL]\n{}\n\n[APP CONTEXT]\n{ctx}",
        worker.soul
    ))
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
        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
