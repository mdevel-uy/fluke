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
    ("architect", true, "Arquitectura"),
    ("pre", false, "Fases previas"),
    ("implementer", true, "Implementa"),
    ("reviews", true, "Revisiones extra"),
    ("docs", true, "Documentación"),
];
const FEATURE_FIELDS: &[FieldSpec] = &[
    ("goal", true, "Objetivo"),
    ("scope", true, "Alcance"),
    ("acceptance", true, "Criterio de aceptación"),
    ("tdd", true, "TDD"),
    ("architect", true, "Arquitectura"),
    ("pre", false, "Fases previas"),
    ("implementer", true, "Implementa"),
    ("reviews", true, "Revisiones extra"),
    ("docs", true, "Documentación"),
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
    /// Where the feature stands once its design is closed (#758):
    /// `design_ready`, `implementing` or `implemented`. `None` without design
    /// issues or while one is still open: the stepper keeps its usual reading.
    pub delivery: Option<String>,
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
    /// Carries the design label (#756): the Designer's mock, not code.
    pub design: bool,
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
        let labels = issue_labels(&issue);
        out.push(MissionProposalIssue {
            number: n,
            title: issue.title,
            state: issue.state,
            milestone: issue.milestone,
            wave: labels
                .iter()
                .find_map(|l| crate::services::execution_labels::wave_number(l)),
            decision: labels.iter().any(|l| l == "pm:decision"),
            design: crate::services::milestone_runs::is_design_issue(&labels),
        });
    }
    Ok(out)
}

/// Design ready vs. feature implemented (#758). Only missions with design
/// issues, all of them closed, get a reading; issues without the label
/// (missions from before it) count as implementation. `issue_count` is how
/// many issues the mission has: one missing from the local mirror may still be
/// open, so the mission is never `implemented` with gaps.
fn delivery(
    proposal: &[MissionProposalIssue],
    issue_count: usize,
    execution: &str,
) -> Option<&'static str> {
    let mut designs = proposal.iter().filter(|i| i.design).peekable();
    designs.peek()?;
    if designs.any(|i| i.state == "open") {
        return None;
    }
    let implementation: Vec<&MissionProposalIssue> =
        proposal.iter().filter(|i| !i.design).collect();
    let open = implementation.iter().any(|i| i.state == "open");
    if !implementation.is_empty() && !open && proposal.len() >= issue_count {
        Some("implemented")
    } else if open && execution != "none" {
        Some("implementing")
    } else {
        Some("design_ready")
    }
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
              WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND w.role IN ('developer', 'devops')",
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
    let guard = FlukeGuard::get(pool).await?;
    let is_guard = guard.as_ref().is_some_and(|g| g.mission_id == mission.id);
    let proposal = proposal(pool, mission.repo_id, &issue_numbers).await?;
    let execution = execution(pool, mission.repo_id, &issue_numbers).await?;
    Ok(MissionDetail {
        delivery: delivery(&proposal, issue_numbers.len(), execution).map(str::to_string),
        is_guard,
        briefs: Mission::briefs(pool, mission.id).await?,
        proposal,
        execution: execution.to_string(),
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

// ---------------------------------------------------------------------------
// Edición de ítems del brief: la usan la herramienta `upsert_item` /
// `remove_item` y los endpoints `/missions/{id}/items`, así las reglas no
// divergen.
// ---------------------------------------------------------------------------

/// Crear (sin `item_id`) o actualizar un ítem del brief. Los campos se
/// fusionan con los existentes; un string vacío borra el campo.
#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpsertMissionItemRequest {
    pub item_id: Option<Uuid>,
    pub kind: String,
    pub title: Option<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BriefEditError {
    /// El pedido no es válido (kind, campo, ítem o misión).
    #[error("{0}")]
    Invalid(String),
    /// La misión existe pero su brief no se puede editar ahora.
    #[error("{0}")]
    Conflict(String),
    #[error("internal error: {0}")]
    Db(#[from] sqlx::Error),
}

/// La misión `id` como destino del brief: tiene que existir y no ser la
/// conversación de guardia (no tiene brief). Para editar, además, no puede
/// estar cerrada; leer el brief de una cerrada sí se puede.
pub async fn brief_target(pool: &Pool, id: Uuid, edit: bool) -> Result<Mission, BriefEditError> {
    let mission = Mission::find_by_id(pool, id).await?.ok_or_else(|| {
        BriefEditError::Invalid(format!(
            "no mission with id {id}: use an id from list_missions or new_mission"
        ))
    })?;
    if FlukeGuard::is_guard(pool, id).await? {
        return Err(BriefEditError::Invalid(format!(
            "mission {id} is your standing conversation, which has no brief: use a mission id from list_missions"
        )));
    }
    if edit && mission.status == mission::STATUS_CLOSED {
        return Err(BriefEditError::Conflict(format!(
            "mission '{}' is closed: restore it before editing its brief",
            mission.title
        )));
    }
    Ok(mission)
}

/// Valida todo antes de escribir (un pedido inválido no deja el ítem a
/// medias), guarda, reabre el brief si ya se había enviado y devuelve el
/// detalle con el estado recalculado.
pub async fn upsert_item(
    pool: &Pool,
    mission_id: Uuid,
    req: &UpsertMissionItemRequest,
) -> Result<MissionDetail, BriefEditError> {
    if !KINDS.contains(&req.kind.as_str()) {
        return Err(BriefEditError::Invalid(format!(
            "kind must be one of {KINDS:?}"
        )));
    }
    let allowed: Vec<&str> = kind_fields(&req.kind).iter().map(|f| f.0).collect();
    if let Some(bad) = req.fields.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(BriefEditError::Invalid(format!(
            "unknown field '{bad}' for a {}: use {allowed:?}",
            req.kind
        )));
    }
    let brief = Mission::find_by_id(pool, mission_id)
        .await?
        .ok_or_else(|| BriefEditError::Invalid("mission not found".into()))?;
    if let Some(item_id) = req.item_id
        && !Mission::items(pool, mission_id)
            .await?
            .iter()
            .any(|i| i.id == item_id)
    {
        return Err(BriefEditError::Invalid("unknown item_id".into()));
    }
    Mission::upsert_item(
        pool,
        mission_id,
        req.item_id,
        &req.kind,
        req.title.as_deref(),
        &req.fields,
    )
    .await?;
    reopen_if_sent(pool, &brief).await?;
    Ok(refresh_status(pool, mission_id).await?)
}

/// Quita un ítem del brief; `unknown item_id` si no es de esta misión.
pub async fn remove_item(
    pool: &Pool,
    mission_id: Uuid,
    item_id: Uuid,
) -> Result<MissionDetail, BriefEditError> {
    let brief = Mission::find_by_id(pool, mission_id)
        .await?
        .ok_or_else(|| BriefEditError::Invalid("mission not found".into()))?;
    if !Mission::remove_item(pool, mission_id, item_id).await? {
        return Err(BriefEditError::Invalid("unknown item_id".into()));
    }
    reopen_if_sent(pool, &brief).await?;
    Ok(refresh_status(pool, mission_id).await?)
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

/// Marca que el Analista deja en el issue de implementación de un diseño
/// cerrado (#757); con ella una corrida repetida sabe que ya existe.
pub fn implements_design_marker(design_issue: i64) -> String {
    format!("<!-- fluke:implements-design #{design_issue} -->")
}

/// Un PR del workspace del designer que entregó el mock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockPr {
    pub number: i64,
    pub url: String,
    pub merged: bool,
}

/// Un issue de diseño de la misión ya cerrado, con lo que se sabe del mock
/// que lo cerró (#757).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClosedDesignIssue {
    pub number: i64,
    pub title: String,
    pub wave: Option<i64>,
    pub prs: Vec<MockPr>,
    /// Rama `design/*` pusheada con el deliverable.
    pub deliverable_ref: Option<String>,
    /// Rutas de los mocks bajo `design/`.
    pub paths: Vec<String>,
    /// Issues de la misión que ya implementan este diseño (llevan la marca).
    pub implemented_by: Vec<i64>,
    /// Issues de la misión que no están en el espejo local: no se sabe si
    /// llevan la marca, así que el Analista los verifica antes de crear otro.
    pub unverified: Vec<i64>,
}

/// Los issues de diseño de la misión que ya están cerrados. Un issue es de
/// diseño si lleva la label de diseño (#756) o si lo tomó un designer (los
/// creados antes de la label). Sin git (o si falla), las rutas quedan vacías.
pub async fn closed_design_issues(
    pool: &Pool,
    git: Option<&git::GitService>,
    repo_id: Option<Uuid>,
    numbers: &[i64],
) -> Result<Vec<ClosedDesignIssue>, sqlx::Error> {
    let Some(repo_id) = repo_id else {
        return Ok(Vec::new());
    };
    let repo = Repo::find_by_id(pool, repo_id).await?;
    let mut issues = Vec::new();
    let mut unverified = Vec::new();
    for &n in numbers {
        match RepoIssue::find_by_repo_and_number(pool, repo_id, n).await? {
            Some(issue) => issues.push(issue),
            None => unverified.push(n),
        }
    }
    let mut out = Vec::new();
    for issue in &issues {
        if !issue.state.eq_ignore_ascii_case("closed") {
            continue;
        }
        let labels = issue_labels(issue);
        let task_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT t.id FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
              WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND w.role = ?3
              ORDER BY t.created_at DESC",
        )
        .bind(repo_id)
        .bind(issue.number)
        .bind(db::models::worker::ROLE_DESIGNER)
        .fetch_all(pool)
        .await?;
        let mut designer_tasks = Vec::new();
        for id in task_ids {
            if let Some(task) = db::models::worker_task::WorkerTask::find_by_id(pool, id).await? {
                designer_tasks.push(task);
            }
        }
        if !crate::services::milestone_runs::is_design_issue(&labels) && designer_tasks.is_empty()
        {
            continue;
        }
        let mut closed = ClosedDesignIssue {
            number: issue.number,
            title: issue.title.clone(),
            wave: labels
                .iter()
                .find_map(|l| crate::services::execution_labels::wave_number(l)),
            unverified: unverified.clone(),
            ..Default::default()
        };
        for task in &designer_tasks {
            if let Some(workspace_id) = task.workspace_id {
                for pr in
                    db::models::pull_request::PullRequest::find_by_workspace_id(pool, workspace_id)
                        .await?
                {
                    if closed.prs.iter().all(|p| p.number != pr.pr_number) {
                        closed.prs.push(MockPr {
                            number: pr.pr_number,
                            url: pr.pr_url,
                            merged: matches!(
                                pr.pr_status,
                                db::models::merge::MergeStatus::Merged
                            ),
                        });
                    }
                }
            }
            if closed.deliverable_ref.is_none() {
                closed.deliverable_ref = task.deliverable_ref.clone();
            }
            if closed.paths.is_empty()
                && let (Some(git), Some(repo)) = (git, repo.as_ref())
            {
                match crate::services::design_artifacts::list_artifacts(pool, git, repo, task).await
                {
                    Ok(Some((_, paths))) => closed.paths = paths,
                    Ok(None) => {}
                    Err(e) => tracing::warn!(
                        task_id = %task.id,
                        "Failed to list the design artifacts for the Analyst: {e}"
                    ),
                }
            }
        }
        let marker = implements_design_marker(issue.number);
        closed.implemented_by = issues
            .iter()
            .filter(|i| i.number != issue.number)
            .filter(|i| i.body.as_deref().is_some_and(|b| b.contains(&marker)))
            .map(|i| i.number)
            .collect();
        out.push(closed);
    }
    Ok(out)
}

fn issue_labels(issue: &RepoIssue) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(&issue.labels)
        .unwrap_or_default()
        .iter()
        .filter_map(|l| l.get("name")?.as_str().map(str::to_string))
        .collect()
}

/// Qué tiene que hacer el Analista con los diseños ya cerrados de la misión:
/// nunca tocarlos y, si falta, abrir el issue de implementación (#757).
fn closed_designs_section(closed: &[ClosedDesignIssue]) -> String {
    if closed.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Diseños ya cerrados: estos issues de diseño están cerrados porque su mock ya se \
         entregó. No los edites, no los comentes, no les agregues labels ni los reabras, y no \
         los vuelvas a crear: el diseño está listo, lo que falta es implementarlo.\n",
    );
    for c in closed {
        out.push_str(&format!("\n- #{} \"{}\"", c.number, c.title.trim()));
        if let Some(wave) = c.wave {
            out.push_str(&format!(" (wave:{wave})"));
        }
        out.push('\n');
        if !c.implemented_by.is_empty() {
            let list: Vec<String> = c.implemented_by.iter().map(|n| format!("#{n}")).collect();
            out.push_str(&format!(
                "  Ya tiene issue de implementación: {}. No crees otro; tratalo como los demás \
                 issues existentes.\n",
                list.join(", ")
            ));
            continue;
        }
        if !c.unverified.is_empty() {
            let list: Vec<String> = c.unverified.iter().map(|n| format!("#{n}")).collect();
            out.push_str(&format!(
                "  Antes de crearle el issue de implementación, mirá con `gh issue view` {} \
                 (son de la misión pero no están en el espejo local): si alguno lleva la marca \
                 {}, ya existe y no crees otro.\n",
                list.join(", "),
                implements_design_marker(c.number),
            ));
        }
        // The designer never opens a PR: its deliverable is the pushed
        // `design/*` ref, so the mock is found by a merged PR or by the
        // artifacts that ref still holds.
        let merged: Vec<&MockPr> = c.prs.iter().filter(|p| p.merged).collect();
        for pr in &merged {
            out.push_str(&format!("  Mock mergeado en el PR #{} ({}).\n", pr.number, pr.url));
        }
        if !c.paths.is_empty() {
            if let Some(r) = &c.deliverable_ref {
                out.push_str(&format!("  Mock entregado en la rama `{r}`.\n"));
            }
            let paths: Vec<String> = c.paths.iter().map(|p| format!("`{p}`")).collect();
            out.push_str(&format!("  Archivos del mock: {}.\n", paths.join(", ")));
        }
        if merged.is_empty() && c.paths.is_empty() {
            let mut known = Vec::new();
            for pr in &c.prs {
                known.push(format!("PR #{} sin mergear", pr.number));
            }
            if let Some(r) = &c.deliverable_ref {
                known.push(format!("rama `{r}` sin archivos del mock"));
            }
            let known = if known.is_empty() {
                "no hay PR ni rama registrados".to_string()
            } else {
                known.join(", ")
            };
            out.push_str(&format!(
                "  No se encuentra el mock ({known}): no inventes la referencia; en el issue \
                 de implementación dejalo como pregunta abierta.\n"
            ));
        }
        let next_wave = c
            .wave
            .map(|w| format!("`wave:{}` o posterior", w + 1))
            .unwrap_or_else(|| "una wave posterior a la del diseño".to_string());
        out.push_str(&format!(
            "  Creá un issue nuevo de implementación para este diseño: con `feature:` y \
             {next_wave}, sin la label `{design}` (lo toma un developer), y en el cuerpo \
             enlazá #{n} y el mock de arriba (PR, rama y rutas que haya). Agregá en una línea sola la marca \
             {marker} para que una corrida repetida no lo duplique.\n",
            design = crate::services::milestone_runs::DESIGN_LABEL,
            n = c.number,
            marker = implements_design_marker(c.number),
        ));
    }
    out.push('\n');
    out
}

/// Prompt de la request que recibe el Analista al aprobar el brief.
/// `closed_designs` sale de [`closed_design_issues`]; `flow`, de
/// [`qa_phases::flow_catalog`](crate::services::qa_phases::flow_catalog).
pub fn analyst_request_prompt(
    d: &MissionDetail,
    version: i64,
    closed_designs: &[ClosedDesignIssue],
    flow: &str,
) -> String {
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
    let closed = closed_designs_section(closed_designs);
    let flow = if flow.trim().is_empty() {
        "(ninguno)"
    } else {
        flow
    };
    format!(
        "Brief de la misión \"{title}\" (versión {version}), aprobado por el user.\n\n\
         {md}\n---\n\
         {revision}{closed}Partí cada ítem del brief en issues chicos y asignables. En el cuerpo de cada \
         issue agregá una sección \"## Brief\" que diga \"Misión: {title} (brief v{version})\" \
         y copie los campos del ítem del que sale. No cambies el alcance del brief: si algo \
         no cierra, listalo como pregunta abierta.\n\n\
         Plan de fases (fluke v2): al final del cuerpo de cada issue que salga de un bug o \
         una feature agregá en una línea sola el bloque <!-- fluke:plan {{...}} --> con estos \
         campos (JSON válido):\n\
         - \"template\": \"tdd\" si el campo TDD del ítem es \"sí\", \"no_tdd\" si es \"no\" o \
         \"no aplica\".\n\
         - \"architect\": true si el campo Arquitectura del ítem es \"sí\".\n\
         - \"pre\": los slugs de los perfiles que nombra el campo Fases previas \
         (ej. [\"data-model\"]); omitilo si está vacío.\n\
         - \"implementer\": el slug del perfil que nombra el campo Implementa (ej. \
         \"devops\"); omitilo si es \"developer\".\n\
         - \"reviews\": los slugs de los perfiles que nombra el campo Revisiones extra (ej. \
         [\"quality\",\"security\"]); omitilo si es \"ninguna\".\n\
         - \"docs\": false si el campo Documentación es \"no\"; omitilo si es \"sí\".\n\
         Perfiles del flujo y sus slugs (usá solo estos):\n{flow}\n\
         Esos campos son la decisión del user: respetalos en todos los issues que salen del \
         ítem. Si un ítem no los tiene (brief anterior a estos campos), decidí vos: \
         arquitectura para un módulo o servicio nuevo, un cambio de capas o del modelo de \
         datos; devops para CI/CD, infraestructura, deploy o nube; seguridad si toca \
         autenticación, permisos, datos sensibles, entradas externas, secretos o \
         dependencias; calidad si agrega o reestructura módulos o abstracciones; documentación \
         salvo que no haya nada documentable.\n\
         Ejemplo: <!-- fluke:plan {{\"template\":\"tdd\",\"reviews\":[\"security\"]}} -->. \
         Los issues de ítems de diseño no llevan el bloque.\n\n\
         Issues de diseño: todo issue que salga de un ítem de diseño lleva la label \
         `{design}` (además de `feature:` y `wave:`); así se despacha al Designer y nunca \
         a un developer. Ningún otro issue la lleva.",
        title = d.mission.title.trim(),
        md = render_markdown(d),
        design = crate::services::milestone_runs::DESIGN_LABEL,
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
read the error, fix the call and retry once before telling the user (except a refused merge: \
see below).
- Destructive or hard-to-undo calls (DELETE, archive, remove, merge, approve, stop, send...) are \
gated by the app, even when the user asked for them: app_api answers needs_confirmation and shows \
the user 'Sí' / 'Cancelar'. Pass a short summary in the user's words, say in one sentence what \
you are about to do and end your turn. When the user's next message confirms, call confirm_action \
with the token; if they say anything else, the action is cancelled.
- Merging a PR (\"mergeá el PR de #N\", or when you offer it): find the issue's repo and its open \
PR in [STATUS] (\"PR #n in repo\", or status_snapshot; otherwise look it up with app_api), and call app_api POST \
/api/repos/{repo}/pull-requests/{number}/merge with no body (merge method and branch deletion \
come from Settings) and a summary like \"mergear el PR #675 (#N)\". It always needs the user's \
yes. If the merge is refused (HTTP 409: conflicts, red CI, task not approved, PR already merged \
or closed; or GitHub's own error), tell the user the exact reason in one line and stop: never \
retry it, never merge another way (gh, git, another endpoint). If it was already merged, say so.
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
- Every bug and feature also records the optional steps of its plan, which are the user's call:\n\
  \"architect\": \"sí\" when an architect writes an ADR before the code (a new module or \
service, a change of layers or of the data model, a project from scratch), otherwise \"no\".\n\
  \"pre\" (optional): other profiles that work before development, by name, from [FLOW \
PROFILES]; leave it empty when none fits.\n\
  \"implementer\": the profile that implements, from [FLOW PROFILES] (e.g. \"devops\" when \
the work is CI/CD, infrastructure, deploy or cloud integration), otherwise \"developer\".\n\
  \"reviews\": extra reviews before the general one, by the names of the gate profiles in \
[FLOW PROFILES] (e.g. \"seguridad\", \"calidad y seguridad\"), or \"ninguna\".\n\
  [FLOW PROFILES] lists the profiles the user put in the flow and when to offer each one; a \
profile that runs always needs no field.\n\
  \"docs\": \"sí\" when the documentation is updated on the PR (the default), \"no\" when the \
change affects nothing documentable.\n\
  Fill them from what the user said and from their standing preferences in [MEMORY] (e.g. \
\"always a security review\"); then propose the rest yourself and confirm with one ask_user \
question per item whose options are your recommended combination and its alternatives (e.g. \
\"Seguridad + docs (recomendado)\" / \"Solo docs\" / \"Arquitectura + seguridad + docs\"). \
Do not ask what is obvious (a typo fix needs no architect). When the user states a preference \
that should hold for future briefs, save it to your memory.
- You may read the code of the current repo (Read, Grep, Glob) to understand the request or \
propose likely files, but you never write code, edit files or run commands: development is \
the workers' job.
- When the brief is complete, give a 2-3 line summary and tell the user to review it and press \
\"Approve brief and send to the Analyst\". Approve it yourself (app_api) only when the user \
explicitly asks you to, and never create the issues yourself: that is the Analyst's job.
- Work for another mission: when the user asks for development work that is not this \
conversation's mission (another repo, or a separate piece of work in the same repo), do not ask \
them to open a new chat and dictate it again. Check list_missions first: if an open mission \
already covers it, use its id. Otherwise call new_mission with its repo (list_repos) and a short \
title; it answers with the new mission's id. Then, in the same turn, record each item with \
upsert_item passing that mission_id, and finish with get_brief and that mission_id to see what \
is missing. Ask for the missing facts here with ask_user and record the answers with the same \
mission_id. If new_mission fails after naming a mission id, the mission exists: carry on with \
that mission_id and never call new_mission again for the same work.
- Approving another mission's brief from here: only when the user explicitly asks for it, never \
on your own. Call app_api POST /api/missions/{id}/approve with that mission's id, body {} and a \
summary that names the mission by its title and says it goes to the Analyst (\"aprobar el brief \
de <title> y mandarlo al Analyst\"); then end your turn and wait for the user's yes before \
confirm_action. This conversation's own mission does not change. If approve answers that the \
brief is not complete, do not retry: call get_brief with that mission_id and tell the user what \
is missing. If it says there is no Analyst worker, tell the user plainly that the team needs an \
Analyst before the brief can be sent. Only one confirmation waits at a time: asking for another \
gated action cancels the previous one, so say so if that happens; after an app restart a pending \
confirmation is gone and the user has to ask again.
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
Its [MEMORY], when present, is what you have learned about the user across past conversations \
(preferences, decisions, how they work): use it to fit your answer, do not recite it, and the \
user's words in this conversation win over it. Its [MISSIONS] lists every open mission with its \
id: you are the same Fluke in every chat, you know them all and can act on any of them with \
mission_id. In a mission's own chat, talk about that mission unless the user brings up another. \
Never mention the block itself.
- Your memory is yours to keep: when the user tells you a preference, a decision or a fact about \
how they work that will matter in future conversations, save it with remember (one short \
sentence in their language). Do not save what only matters for the task at hand. If something \
in [MEMORY] is no longer true, forget it (and remember the new version). When the user asks you \
to forget something, use forget; when they ask what you remember, use list_memories.
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
pub async fn turn_context(
    pool: &Pool,
    mission: &Mission,
    user_text: Option<&str>,
) -> Result<String, sqlx::Error> {
    let ctx = mission
        .ui_context
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("unknown");
    let status = status_snapshot(pool).await?;
    // One chat per mission, one Fluke for all: every chat knows every mission.
    let missions = missions_block(pool, mission.id).await?;
    let channel = if take_voice_turn(mission.id) {
        VOICE_CHANNEL
    } else {
        ""
    };
    let memory = memory_block(pool, user_text).await?;
    let flow = match crate::services::qa_phases::flow_catalog(pool).await? {
        f if f.is_empty() => String::new(),
        f => format!("\n\n[FLOW PROFILES]\n{f}"),
    };
    Ok(format!(
        "{CONTEXT_OPEN}\n[APP CONTEXT]\n{ctx}{missions}{channel}{memory}{flow}\n\n[STATUS]\n{status}\n{CONTEXT_CLOSE}"
    ))
}

/// `[MISSIONS]` for a turn: every open mission with its id and where its
/// brief stands, so the same Fluke knows them all from any chat.
const MISSIONS_BLOCK_MAX: usize = 20;

async fn missions_block(pool: &Pool, this: Uuid) -> Result<String, sqlx::Error> {
    let guard = FlukeGuard::get(pool).await?.map(|g| g.mission_id);
    let mut lines = Vec::new();
    for m in Mission::list(pool).await? {
        if m.status == mission::STATUS_CLOSED || Some(m.id) == guard {
            continue;
        }
        if lines.len() == MISSIONS_BLOCK_MAX {
            lines.push("- ... (more: list_missions)".to_string());
            break;
        }
        let here = if m.id == this { ", this chat" } else { "" };
        let d = detail(pool, m).await?;
        let brief = if d.complete {
            "brief complete".to_string()
        } else {
            format!("missing: {}", d.missing.join(", "))
        };
        let title = if d.mission.title.trim().is_empty() {
            "(untitled)"
        } else {
            d.mission.title.trim()
        };
        lines.push(format!(
            "- \"{title}\" (id {}, {}, {brief}{here})",
            d.mission.id, d.mission.status
        ));
    }
    if lines.is_empty() {
        return Ok("

[MISSIONS]
No open missions.".to_string());
    }
    Ok(format!("

[MISSIONS]
{}", lines.join("
")))
}

// ---------------------------------------------------------------------------
// Memoria (J3): embebida en SQLite, la escribe Fluke mismo
// ---------------------------------------------------------------------------

/// Up to this many memories, all of them go into every turn.
const MEMORY_ALL_MAX: i64 = 30;
const MEMORY_RELEVANT: i64 = 12;
const MEMORY_MOST_USED: i64 = 5;

/// `[MEMORY]` for a turn: everything while memory is small; past that, the
/// memories that match the user's message plus the most used ones. An event
/// batch is not the user: it gets no memory.
async fn memory_block(pool: &Pool, user_text: Option<&str>) -> Result<String, sqlx::Error> {
    use db::models::fluke_memory::FlukeMemory;
    let Some(text) = user_text.filter(|t| !t.starts_with(EVENTS_PREFIX)) else {
        return Ok(String::new());
    };
    let total = FlukeMemory::count(pool).await?;
    if total == 0 {
        return Ok(String::new());
    }
    let mut memories = if total <= MEMORY_ALL_MAX {
        FlukeMemory::list(pool).await?
    } else {
        let mut m = FlukeMemory::relevant(pool, text, MEMORY_RELEVANT).await?;
        for used in FlukeMemory::most_used(pool, MEMORY_MOST_USED).await? {
            if !m.iter().any(|x| x.id == used.id) {
                m.push(used);
            }
        }
        m
    };
    memories.sort_by_key(|m| m.id);
    let ids: Vec<i64> = memories.iter().map(|m| m.id).collect();
    FlukeMemory::mark_used(pool, &ids).await?;
    let lines: Vec<String> = memories
        .iter()
        .map(|m| format!("- #{} ({}) {}", m.id, m.kind, m.fact))
        .collect();
    Ok(format!("\n\n[MEMORY]\n{}", lines.join("\n")))
}

// ---------------------------------------------------------------------------
// Canal de turno (J2.1): chat o voz, y la respuesta en streaming
// ---------------------------------------------------------------------------

const VOICE_CHANNEL: &str = "\n\n[CHANNEL]\nvoice: the user hears your reply and may not see \
the screen. Answer in one to three short spoken sentences, no markdown, no lists, no ids or \
paths. For an order: first say in a few words what you are about to do, then do it, then say \
it is done. Read questions aloud with their options (the recommended one first); chips may not \
be visible.";

fn voice_turns() -> &'static std::sync::Mutex<std::collections::HashSet<Uuid>> {
    static VOICE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<Uuid>>> =
        std::sync::OnceLock::new();
    VOICE.get_or_init(Default::default)
}

/// The next turn of this mission comes by voice: its context says so.
pub fn mark_voice_turn(mission_id: Uuid) {
    if let Ok(mut set) = voice_turns().lock() {
        set.insert(mission_id);
    }
}

fn take_voice_turn(mission_id: Uuid) -> bool {
    voice_turns()
        .lock()
        .map(|mut set| set.remove(&mission_id))
        .unwrap_or(false)
}

/// What a channel needs from one line of the CLI's stream-json output.
#[derive(Debug, PartialEq)]
pub enum TurnEvent {
    /// A piece of Fluke's reply, as it is written.
    Delta(String),
    /// The turn ended; the full final reply.
    Done { text: String, is_error: bool },
}

pub fn turn_event(line: &str) -> Option<TurnEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    match v.get("type")?.as_str()? {
        "stream_event" => {
            let event = v.get("event")?;
            if event.get("type")?.as_str()? != "content_block_delta" {
                return None;
            }
            let delta = event.get("delta")?;
            (delta.get("type")?.as_str()? == "text_delta")
                .then(|| delta.get("text")?.as_str().map(|t| TurnEvent::Delta(t.to_string())))
                .flatten()
        }
        "result" => Some(TurnEvent::Done {
            text: v
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => None,
    }
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
- A worker waiting for an answer (task.waiting_user) always deserves attention. Call \
get_stuck_issues to read its question, options and who it asked (\"to\").
- Asked to the user (no \"to\"): explain it in one sentence and ask the user with ask_user using \
the agent's options (the recommended one first). When the user answers, call answer_agent with \
that issue, its repo and the chosen option: the worker carries on.
- Asked to you (\"to\": \"fluke\"): you are the link between the workers, and you decide.
  * Answer it yourself (answer_agent) when the answer is in the brief, the issue, other issues, \
[MEMORY], the code or the conventions, or it is a small technical call (naming, structure, \
which library already in use, how it fits another issue). Then tell the user in one line what \
you answered and why.
  * Hand it to another worker when it is their job (a design asset to the Designer, a breakdown \
change to the Analyst): create the task with app_api, answer the asking worker with what to do \
meanwhile, and tell the user in one line.
  * Ask the user (ask_user, with your recommendation first) for product, scope or design \
decisions, anything that changes what the user approved, costs money or cannot be undone. Then \
pass their answer with answer_agent.
  Never stay SILENT on a question: the worker is waiting.

Each mission has its own chat (a tab) where the user works on it, and several can run at the \
same time. This standing conversation is for the app as a whole: events, status, orders and \
starting missions.
- New development work asked here: new_mission with its repo and a short title, fill in what \
you already know with its mission_id, and tell the user to continue in the mission's tab.
- To act on a mission from here (its brief, approving it, running it), pass its mission_id: in \
this conversation the brief tools need it.

Following the work through: after the brief you keep each mission moving until it is merged, \
always offering the next step instead of waiting to be asked. [STATUS] under \"Waiting for the \
user\" tells you what is ready.
- A brief ready to approve: summarize it in two lines and offer to approve it. If the user says \
yes, call app_api POST /api/missions/{id}/approve with body {} and a summary naming the \
mission by its title (the app asks them to confirm). The same goes for a mission that is not in \
focus: pass its id, and the focus does not change.
- A breakdown ready with nothing running: say how many issues and waves, and offer to run the \
milestone. Ask with ask_user (\"Ejecutar ahora\" / \"Paso a paso\" / \"Después\"); on yes call \
app_api POST /api/repos/{repo_id}/milestone-runs/play with that milestone (step_mode true for \
paso a paso).
- An approved task with its PR ready to merge: say what it does in one line and offer to merge \
it. To merge, call app_api POST /api/repos/{repo}/pull-requests/{number}/merge with a summary \
like \"mergear el PR #675\": the app shows the user the confirmation; the merge is always theirs. \
If it is refused, give the reason in one line and do not retry.
- A wave or a milestone that finished: one line on what is done and what comes next.
Never run, approve or merge on your own: offer, and act only on the user's yes.";

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
/// Tope del motivo de falla por tarea en el snapshot: alcanza para el error
/// resumido sin inflar el prompt.
const SNAPSHOT_REASON_MAX: usize = 200;

/// `s` en una sola línea (espacios y saltos colapsados) y acotado a `max`
/// caracteres; `None` si queda vacío.
fn one_line(s: &str, max: usize) -> Option<String> {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    if flat.chars().count() <= max {
        return Some(flat);
    }
    let mut cut: String = flat.chars().take(max).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    Some(cut)
}

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
    // Following the work through (J4): what is ready for the user's next
    // step, so Fluke can offer it.
    for r in sqlx::query(
        "SELECT t.issue_number, t.title, w.role, \
                (SELECT p.pr_number FROM pull_requests p \
                  WHERE p.workspace_id = t.workspace_id AND p.pr_status = 'open' \
                  ORDER BY p.created_at DESC LIMIT 1) AS pr_number, \
                (SELECT r.name FROM repos r WHERE r.id = t.repo_id) AS repo \
           FROM worker_tasks t LEFT JOIN workers w ON w.id = t.worker_id \
          WHERE t.status = 'approved' ORDER BY t.completed_at LIMIT ?",
    )
    .bind(SNAPSHOT_LIST_MAX)
    .fetch_all(pool)
    .await?
    {
        let pr = match (
            r.get::<Option<i64>, _>("pr_number"),
            r.get::<Option<String>, _>("repo"),
        ) {
            (Some(n), Some(repo)) => format!(": approved, PR #{n} in {repo} ready to merge"),
            _ => ": approved, ready to merge".to_string(),
        };
        waiting.push(task_line(&r, &pr));
    }
    for m in Mission::list(pool).await? {
        if m.status == mission::STATUS_CLOSED {
            continue;
        }
        let title = m.title.clone();
        let d = detail(pool, m).await?;
        let open: Vec<&str> = d
            .proposal
            .iter()
            .filter(|i| i.state == "open")
            .filter_map(|i| i.milestone.as_deref())
            .collect();
        if d.analyst_status.as_deref() == Some("done") && !open.is_empty() && d.execution == "none"
        {
            let mut milestones = open.clone();
            milestones.sort_unstable();
            milestones.dedup();
            waiting.push(format!(
                "\n- mission \"{title}\": breakdown ready, nothing running (milestones: {})",
                milestones.join(", ")
            ));
        }
    }
    if !waiting.is_empty() {
        out.push_str("\nWaiting for the user:");
        out.extend(waiting);
    }

    let failed = sqlx::query(
        "SELECT t.issue_number, t.title, w.role, t.failure_kind, t.failure_reason FROM worker_tasks t \
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
            // "kind · motivo", cada parte sólo si existe; sin ninguna, nada.
            let parts: Vec<String> = [
                r.get::<Option<String>, _>("failure_kind"),
                r.get::<Option<String>, _>("failure_reason"),
            ]
            .into_iter()
            .flatten()
            .filter_map(|s| one_line(&s, SNAPSHOT_REASON_MAX))
            .collect();
            let extra = if parts.is_empty() {
                String::new()
            } else {
                format!(": {}", parts.join(" · "))
            };
            out.push_str(&task_line(r, &extra));
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
    let mission_id = json!({
        "type": "string",
        "description": "Id of the mission whose brief to act on (list_missions, new_mission). Optional in a mission's chat (default: that mission); required in your standing conversation."
    });
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
            "description": "Set the mission title and/or its repo (repo id or name from list_repos). The repo can't change once the brief was sent to the Analyst. Returns the brief status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "mission_id": mission_id,
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
                    "mission_id": mission_id,
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
                "properties": {
                    "mission_id": mission_id,
                    "item_id": { "type": "string" }
                },
                "required": ["item_id"]
            }
        },
        {
            "name": "get_brief",
            "description": "Return the current brief as markdown, its items with ids, and what is missing.",
            "inputSchema": {
                "type": "object",
                "properties": { "mission_id": mission_id }
            }
        },
        {
            "name": "remember",
            "description": "Save something about the user that will matter in future conversations: a preference, a decision or a fact about how they work. One short sentence in their language. Saving the same fact twice is harmless.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fact": { "type": "string" },
                    "kind": { "type": "string", "enum": db::models::fluke_memory::KINDS }
                },
                "required": ["fact"]
            }
        },
        {
            "name": "forget",
            "description": "Delete a memory by its id (the #n in [MEMORY] or list_memories).",
            "inputSchema": {
                "type": "object",
                "properties": { "memory_id": { "type": "integer" } },
                "required": ["memory_id"]
            }
        },
        {
            "name": "list_memories",
            "description": "Everything you remember about the user, with ids.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_missions",
            "description": "The open missions (pieces of work you follow): id, title, status and repo. [MISSIONS] in the context block already lists them.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "new_mission",
            "description": "Start a mission for new development work in a repo, from any conversation. Answers with the new mission's id: pass it as mission_id to set_mission, upsert_item, remove_item and get_brief to fill its brief. The mission gets its own chat (tab), where the user continues. Check list_missions first so you do not duplicate an open one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo id or name (list_repos)." },
                    "title": { "type": "string", "description": "Short mission title." }
                },
                "required": ["repo"]
            }
        },
        {
            "name": "get_stuck_issues",
            "description": "List the open issues that need a person: why each one is stuck (question, credential, failed, review_cap, no_progress), the stuck phase, the repo and, for a question, the agent's question with its options. Without repo: the mission's repo; in your standing conversation, every repo.",
            "inputSchema": {
                "type": "object",
                "properties": { "repo": { "type": "string", "description": "Repo id or name. Optional." } }
            }
        },
        {
            "name": "answer_agent",
            "description": "Answer, on the user's behalf, the question a coding agent is waiting on in an issue. Only after the user confirmed this exact answer in this conversation. The answer is one of the agent's option keys or a short free text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": { "type": "integer" },
                    "answer": { "type": "string" },
                    "repo": { "type": "string", "description": "Repo id or name of the issue. Optional when only one repo has that issue waiting." }
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
        "mission_id": d.mission.id,
        "title": d.mission.title,
        "repo": d.repo_name,
        "items": items,
        "missing": d.missing,
        "complete": d.complete,
    })
    .to_string()
}

pub async fn resolve_repo(pool: &Pool, value: &str) -> Result<Repo, String> {
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

/// `new_mission` from any conversation (#779). `create` makes the session and
/// the mission in the repo's scratch worktree (the server owns that); the repo
/// is resolved before, so an unknown repo creates nothing. The new mission
/// gets its own chat; Fluke fills in what it knows with `mission_id`.
pub async fn new_mission<F, Fut>(
    pool: &Pool,
    session_id: Uuid,
    args: &Value,
    create: F,
) -> Result<String, String>
where
    F: FnOnce(Uuid) -> Fut,
    Fut: std::future::Future<Output = Result<Mission, String>>,
{
    let db_err = |e: sqlx::Error| format!("internal error: {e}");
    Mission::find_by_session_id(pool, session_id)
        .await
        .map_err(db_err)?
        .ok_or("this session has no mission")?;
    let repo = args
        .get("repo")
        .and_then(Value::as_str)
        .ok_or("missing repo")?;
    let repo = resolve_repo(pool, repo).await?;
    let created = create(repo.id)
        .await
        .map_err(|e| format!("could not start the mission: {e}"))?;
    // From here on the mission exists: a failure names it so Fluke carries on
    // with mission_id instead of starting a duplicate.
    let after = |e: sqlx::Error| {
        format!(
            "mission {} was created but {e}: do not call new_mission again, continue with mission_id {}",
            created.id, created.id
        )
    };
    if let Some(title) = args
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Mission::set_title(pool, created.id, title)
            .await
            .map_err(after)?;
    }
    let d = refresh_status(pool, created.id).await.map_err(after)?;
    let missing = if d.missing.is_empty() {
        "nothing".to_string()
    } else {
        d.missing.join(", ")
    };
    Ok(format!(
        "Mission started (id {id}) in {}: it has its own tab, where the user continues. Pass \
         mission_id {id} to set_mission, upsert_item, remove_item and get_brief to fill in what \
         you already know. Missing: {missing}",
        repo.display_name,
        id = created.id
    ))
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

/// La misión cuyo brief aprueba la llamada (`POST /api/missions/{id}/approve`).
fn approve_target(method: &reqwest::Method, path: &str) -> Option<Uuid> {
    if *method != reqwest::Method::POST {
        return None;
    }
    let path = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["", "api", "missions", id, "approve"] => Uuid::parse_str(id).ok(),
        _ => None,
    }
}

/// Texto de la confirmación. Si aprueba el brief de otra misión, nombra esa
/// misión y que va al Analyst aunque el resumen del modelo no lo haga.
fn approve_summary(summary: Option<String>, target_title: Option<&str>, label: &str) -> String {
    match (summary, target_title) {
        (Some(s), Some(title)) if s.to_lowercase().contains(&title.to_lowercase()) => s,
        (Some(s), Some(title)) => format!("{s} (brief de «{title}», al Analyst)"),
        (None, Some(title)) => format!("aprobar el brief de «{title}» y mandarlo al Analyst"),
        (Some(s), None) => s,
        (None, None) => label.to_string(),
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

    // The brief tools act on the conversation's own mission; the standing
    // conversation has none, so there they need a mission_id.
    let guard = FlukeGuard::get(pool)
        .await
        .map_err(db_err)?
        .filter(|g| g.mission_id == id);
    // An explicit mission_id wins over both: Fluke edits another mission's
    // brief without leaving this conversation.
    let brief_tool = matches!(
        name,
        "set_mission" | "upsert_item" | "remove_item" | "get_brief"
    );
    let explicit = args
        .get("mission_id")
        .filter(|v| brief_tool && !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()));
    let id_for_brief = match (explicit, &guard) {
        (Some(v), _) => {
            let raw = v
                .as_str()
                .ok_or("mission_id must be a string: the mission's id")?
                .trim();
            let target = Uuid::parse_str(raw).map_err(|_| {
                format!("invalid mission_id '{raw}': use the id from list_missions or new_mission")
            })?;
            brief_target(pool, target, name != "get_brief")
                .await
                .map_err(|e| e.to_string())?
                .id
        }
        (None, Some(_)) if brief_tool => {
            return Err("in your standing conversation the brief tools need mission_id: see \
                        [MISSIONS] or list_missions, or new_mission for new work"
                .into());
        }
        _ => id,
    };

    match name {
        "remember" => {
            use db::models::fluke_memory::{FlukeMemory, KINDS};
            let fact = args
                .get("fact")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .ok_or("missing fact")?;
            if fact.chars().count() > 500 {
                return Err("keep a memory to one short sentence".into());
            }
            let kind = args.get("kind").and_then(Value::as_str).unwrap_or("fact");
            if !KINDS.contains(&kind) {
                return Err(format!("kind must be one of {KINDS:?}"));
            }
            let id = FlukeMemory::remember(pool, fact, kind)
                .await
                .map_err(db_err)?;
            Ok(format!("Remembered as #{id}."))
        }
        "forget" => {
            let id = args
                .get("memory_id")
                .and_then(Value::as_i64)
                .ok_or("missing memory_id")?;
            if db::models::fluke_memory::FlukeMemory::forget(pool, id)
                .await
                .map_err(db_err)?
            {
                Ok(format!("Forgot #{id}."))
            } else {
                Err(format!("no memory #{id}"))
            }
        }
        "list_memories" => {
            let all = db::models::fluke_memory::FlukeMemory::list(pool)
                .await
                .map_err(db_err)?;
            if all.is_empty() {
                return Ok("You do not remember anything about the user yet.".into());
            }
            Ok(all
                .iter()
                .map(|m| format!("#{} ({}) {}", m.id, m.kind, m.fact))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_missions" => {
            let mut out = Vec::new();
            for m in Mission::list(pool).await.map_err(db_err)? {
                if m.status == mission::STATUS_CLOSED
                    || guard.as_ref().is_some_and(|g| g.mission_id == m.id)
                {
                    continue;
                }
                let repo = match m.repo_id {
                    Some(r) => Repo::find_by_id(pool, r)
                        .await
                        .map_err(db_err)?
                        .map(|r| r.display_name),
                    None => None,
                };
                out.push(json!({
                    "mission_id": m.id,
                    "title": m.title,
                    "status": m.status,
                    "repo": repo,
                }));
            }
            Ok(Value::Array(out).to_string())
        }
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
            // Validate the repo before writing anything; same rule as the
            // PATCH: once the brief was sent the repo can't change.
            let repo = match args.get("repo").and_then(Value::as_str) {
                Some(repo) => Some(resolve_repo(pool, repo).await?),
                None => None,
            };
            if let Some(repo) = &repo {
                let current = Mission::find_by_id(pool, id_for_brief)
                    .await
                    .map_err(db_err)?
                    .ok_or("mission not found")?;
                if current.analyst_task_id.is_some() && current.repo_id != Some(repo.id) {
                    return Err("the brief was already sent; the repo can't change".into());
                }
            }
            if let Some(title) = args.get("title").and_then(Value::as_str) {
                Mission::set_title(pool, id_for_brief, title.trim())
                    .await
                    .map_err(db_err)?;
            }
            if let Some(repo) = repo {
                Mission::set_repo(pool, id_for_brief, Some(repo.id))
                    .await
                    .map_err(db_err)?;
            }
            let d = refresh_status(pool, id_for_brief).await.map_err(db_err)?;
            Ok(status_text(&d))
        }
        "upsert_item" => {
            let a: UpsertMissionItemRequest = serde_json::from_value(args.clone())
                .map_err(|e| format!("invalid arguments: {e}"))?;
            let d = upsert_item(pool, id_for_brief, &a)
                .await
                .map_err(|e| e.to_string())?;
            Ok(status_text(&d))
        }
        "remove_item" => {
            let item_id = args
                .get("item_id")
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or("missing item_id")?;
            let d = remove_item(pool, id_for_brief, item_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(status_text(&d))
        }
        "get_brief" => {
            let d = refresh_status(pool, id_for_brief).await.map_err(db_err)?;
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
                .map(str::to_string);
            // Approving another mission's brief from here (#780): the user must
            // see which mission goes to the Analyst, whatever the model wrote.
            let target_title = match approve_target(&method, &path).filter(|t| *t != id) {
                Some(target) => Mission::find_by_id(pool, target)
                    .await
                    .map_err(db_err)?
                    .map(|m| m.title.trim().to_string())
                    .filter(|t| !t.is_empty()),
                None => None,
            };
            let summary = approve_summary(summary, target_title.as_deref(), &label);
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

        // An approved task whose PR is open: ready to merge (J4).
        let (repo, ws) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO repos (id, path, name, display_name) VALUES (?, '/r/fluke', 'fluke', 'Fluke')")
            .bind(repo)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, issue_number, status, workspace_id) \
             VALUES (?, ?, ?, 1, '#666 Play por milestone', 'p', 666, 'approved', ?)",
        )
        .bind(Uuid::new_v4())
        .bind(dev)
        .bind(repo)
        .bind(ws)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pull_requests (id, workspace_id, repo_id, pr_url, pr_number, pr_status, target_branch_name) \
             VALUES ('pr2', ?, ?, 'u2', 690, 'open', 'main')",
        )
        .bind(ws)
        .bind(repo)
        .execute(&pool)
        .await
        .unwrap();

        let s = status_snapshot(&pool).await.unwrap();
        assert!(s.starts_with("Tasks: 1 running, 0 queued"), "{s}");
        assert!(s.contains("Running:\n- #664 Vista Plan (developer)"), "{s}");
        assert!(s.contains("- #663 Vista Plan (developer): asks"), "{s}");
        assert!(s.contains("#675 (CI passing"), "{s}");
        assert!(
            s.contains("- #666 Play por milestone (developer): approved, PR #690 in fluke ready to merge"),
            "{s}"
        );
    }

    /// In-memory DB with one developer worker, for the failed-task snapshot tests.
    async fn failed_snapshot_pool() -> (sqlx::SqlitePool, Uuid) {
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
        (pool, dev)
    }

    /// A task that failed just now (inside the "Failed (24 h)" window).
    async fn insert_failed_task(
        pool: &sqlx::SqlitePool,
        dev: Uuid,
        n: i64,
        title: &str,
        reason: Option<&str>,
        kind: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, issue_number, status, failure_reason, failure_kind, completed_at) \
             VALUES (?, ?, ?, 1, ?, 'p', ?, 'failed', ?, ?, datetime('now'))",
        )
        .bind(Uuid::new_v4())
        .bind(dev)
        .bind(Uuid::new_v4())
        .bind(format!("#{n} {title}"))
        .bind(n)
        .bind(reason)
        .bind(kind)
        .execute(pool)
        .await
        .unwrap();
    }

    /// The task lines listed under "Failed (24 h):", in snapshot order.
    fn failed_section(snapshot: &str) -> Vec<&str> {
        snapshot
            .lines()
            .skip_while(|l| !l.starts_with("Failed (24 h):"))
            .skip(1)
            .take_while(|l| l.starts_with("- "))
            .collect()
    }

    #[tokio::test]
    async fn status_snapshot_includes_failure_reason_next_to_each_failed_task() {
        let (pool, dev) = failed_snapshot_pool().await;
        insert_failed_task(
            &pool,
            dev,
            777,
            "Implementar advanced settings colapsable en la tarjeta de provider",
            Some("El agente terminó con error: cargo test falló en provider_card"),
            None,
        )
        .await;
        insert_failed_task(
            &pool,
            dev,
            778,
            "Otra tarea",
            Some("Error de API (529): overloaded"),
            Some("infra"),
        )
        .await;

        let s = status_snapshot(&pool).await.unwrap();
        let failed = failed_section(&s);
        assert_eq!(failed.len(), 2, "{s}");
        let first = failed.iter().find(|l| l.contains("#777")).expect(&s);
        assert!(
            first.contains("El agente terminó con error: cargo test falló en provider_card"),
            "{s}"
        );
        // The kind (already shown today) must survive next to the reason.
        let second = failed.iter().find(|l| l.contains("#778")).expect(&s);
        assert!(second.contains("infra"), "{s}");
        assert!(second.contains("Error de API (529): overloaded"), "{s}");
    }

    #[tokio::test]
    async fn status_snapshot_failure_reason_is_one_bounded_line() {
        let (pool, dev) = failed_snapshot_pool().await;
        let long_multiline = format!(
            "Primera línea del error\n\n{}\nSENTINEL_TAIL",
            "x".repeat(4000)
        );
        insert_failed_task(&pool, dev, 780, "Con motivo largo", Some(&long_multiline), None).await;
        insert_failed_task(&pool, dev, 781, "Con motivo corto", Some("falló el build"), None).await;

        let s = status_snapshot(&pool).await.unwrap();
        let failed = failed_section(&s);
        // Newlines in the reason must not split the entry into extra lines,
        // otherwise the list format breaks.
        assert_eq!(failed.len(), 2, "{s}");
        let long_line = failed.iter().find(|l| l.contains("#780")).expect(&s);
        assert!(long_line.contains("Primera línea del error"), "{s}");
        assert!(!s.contains("SENTINEL_TAIL"), "reason not truncated: {s}");
        assert!(
            long_line.chars().count() <= 500,
            "reason not bounded ({} chars): {s}",
            long_line.chars().count()
        );
        let short_line = failed.iter().find(|l| l.contains("#781")).expect(&s);
        assert!(short_line.contains("falló el build"), "{s}");
        assert!(s.lines().any(|l| l.starts_with("Open PRs")), "{s}");
    }

    #[tokio::test]
    async fn status_snapshot_failed_task_without_reason_stays_clean() {
        let (pool, dev) = failed_snapshot_pool().await;
        insert_failed_task(&pool, dev, 790, "Sin motivo nulo", None, None).await;
        insert_failed_task(&pool, dev, 791, "Sin motivo vacío", Some(""), None).await;
        insert_failed_task(&pool, dev, 792, "Sin motivo en blanco", Some("  \n "), Some("infra")).await;

        let s = status_snapshot(&pool).await.unwrap();
        let failed = failed_section(&s);
        assert_eq!(failed.len(), 3, "{s}");
        assert!(!s.contains("null"), "{s}");
        assert!(!s.contains("None"), "{s}");
        for line in failed {
            let line = line.trim_end();
            assert!(
                !line.ends_with(':') && !line.ends_with(" -"),
                "dangling separator in {line:?}"
            );
        }
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
            "goal": "g", "scope": "s", "acceptance": "a", "tdd": "sí", "architect": "no",
            "implementer": "developer", "reviews": "seguridad", "docs": "sí" } });
        call_tool(&pool, session, "upsert_item", &args)
            .await
            .unwrap();

        let m = Mission::find_by_id(&pool, m.id).await.unwrap().unwrap();
        assert_eq!(m.status, mission::STATUS_BRIEF_READY);
    }

    async fn brief_pool() -> sqlx::SqlitePool {
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
        pool
    }

    /// A mission with its own conversation: (session id, mission).
    async fn conversation(pool: &sqlx::SqlitePool, title: &str) -> (Uuid, Mission) {
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session)
            .bind(Uuid::new_v4())
            .execute(pool)
            .await
            .unwrap();
        let m = Mission::create(pool, session, Some(Uuid::new_v4()))
            .await
            .unwrap();
        Mission::set_title(pool, m.id, title).await.unwrap();
        (session, m)
    }

    /// What the server does for `new_mission`, minus the scratch worktree.
    async fn create_in(pool: &sqlx::SqlitePool, repo_id: Uuid) -> Result<Mission, String> {
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session)
            .bind(Uuid::new_v4())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Mission::create(pool, session, Some(repo_id))
            .await
            .map_err(|e| e.to_string())
    }

    async fn web_repo(pool: &sqlx::SqlitePool) -> Uuid {
        let repo = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name) VALUES (?, '/r/web', 'web', 'Web')",
        )
        .bind(repo)
        .execute(pool)
        .await
        .unwrap();
        repo
    }

    /// The id that `new_mission` answers with.
    fn started_id(out: &str) -> Uuid {
        let rest = out
            .strip_prefix("Mission started (id ")
            .unwrap_or_else(|| panic!("{out}"));
        Uuid::parse_str(&rest[..36]).unwrap()
    }

    #[tokio::test]
    async fn new_mission_from_a_mission_conversation_keeps_its_own_mission() {
        let pool = brief_pool().await;
        let repo = web_repo(&pool).await;
        let (here, own) = conversation(&pool, "Landing").await;

        let out = new_mission(&pool, here, &json!({ "repo": "web", "title": "Login" }), |r| {
            create_in(&pool, r)
        })
        .await
        .unwrap();
        let id = started_id(&out);
        assert!(out.contains(&format!("mission_id {id}")) && out.contains("Missing:"), "{out}");
        assert!(out.contains("its own tab"), "{out}");
        let created = Mission::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!((created.title.as_str(), created.repo_id), ("Login", Some(repo)));

        // This conversation keeps its mission.
        let m = Mission::find_by_session_id(&pool, here).await.unwrap().unwrap();
        assert_eq!(m.id, own.id);

        // Without a title it still starts.
        let out = new_mission(&pool, here, &json!({ "repo": repo.to_string() }), |r| {
            create_in(&pool, r)
        })
        .await
        .unwrap();
        started_id(&out);
    }

    #[tokio::test]
    async fn new_mission_from_the_standing_conversation_is_filled_by_id() {
        let pool = brief_pool().await;
        web_repo(&pool).await;
        let (guard_session, guard) = conversation(&pool, "Fluke").await;
        FlukeGuard::set(&pool, guard.id).await.unwrap();

        let out = new_mission(&pool, guard_session, &json!({ "repo": "Web", "title": "Login" }), |r| {
            create_in(&pool, r)
        })
        .await
        .unwrap();
        let id = started_id(&out);

        // From the standing conversation the brief tools need its id.
        assert!(
            call_tool(&pool, guard_session, "upsert_item", &json!({ "kind": "bug", "title": "x" }))
                .await
                .unwrap_err()
                .contains("need mission_id")
        );
        call_tool(
            &pool,
            guard_session,
            "upsert_item",
            &json!({ "mission_id": id.to_string(), "kind": "bug", "title": "x" }),
        )
        .await
        .unwrap();
        assert_eq!(Mission::items(&pool, id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn new_mission_with_an_unknown_repo_creates_nothing() {
        let pool = brief_pool().await;
        web_repo(&pool).await;
        let (here, _) = conversation(&pool, "Landing").await;
        let before = Mission::list(&pool).await.unwrap().len();
        let mut called = false;
        let err = new_mission(&pool, here, &json!({ "repo": "nope" }), |r| {
            called = true;
            create_in(&pool, r)
        })
        .await
        .unwrap_err();
        assert!(err.contains("unknown repo 'nope'"), "{err}");
        assert!(!called);
        assert_eq!(Mission::list(&pool).await.unwrap().len(), before);
    }

    #[tokio::test]
    async fn new_mission_then_items_by_id_leaves_the_brief_loaded() {
        let pool = brief_pool().await;
        web_repo(&pool).await;
        let (here, own) = conversation(&pool, "Landing").await;

        let out = new_mission(&pool, here, &json!({ "repo": "web", "title": "Login" }), |r| {
            create_in(&pool, r)
        })
        .await
        .unwrap();
        let id = started_id(&out);
        let target = id.to_string();
        for (kind, title, field) in [
            ("feature", "Login con GitHub", "goal"),
            ("bug", "Logout no limpia sesión", "symptom"),
        ] {
            call_tool(
                &pool,
                here,
                "upsert_item",
                &json!({ "mission_id": target, "kind": kind, "title": title,
                         "fields": { field: "g" } }),
            )
            .await
            .unwrap();
        }
        call_tool(&pool, here, "get_brief", &json!({ "mission_id": target }))
            .await
            .unwrap();

        // Opening the new mission shows both items; this conversation's brief is untouched.
        let titles: Vec<String> = Mission::items(&pool, id)
            .await
            .unwrap()
            .into_iter()
            .map(|i| i.title)
            .collect();
        assert_eq!(titles.len(), 2, "{titles:?}");
        assert!(titles.iter().any(|t| t == "Login con GitHub"), "{titles:?}");
        assert!(Mission::items(&pool, own.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn brief_tools_act_on_another_mission_by_id() {
        let pool = brief_pool().await;
        let (here, own) = conversation(&pool, "Landing").await;
        let (_, other) = conversation(&pool, "Login").await;
        let target = other.id.to_string();

        // Created in the other mission's brief, not in this conversation's.
        let out = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "kind": "feature", "title": "Login con GitHub",
                     "fields": { "goal": "g", "scope": "s" } }),
        )
        .await
        .unwrap();
        assert!(out.contains(&target) && out.contains("acceptance"), "{out}");
        assert!(Mission::items(&pool, own.id).await.unwrap().is_empty());
        let items = Mission::items(&pool, other.id).await.unwrap();
        assert_eq!(items.len(), 1);
        let item_id = items[0].id;

        // Update by id: fields merge and an empty string clears one.
        call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "item_id": item_id, "kind": "feature",
                     "fields": { "scope": "", "acceptance": "a", "tdd": "no" } }),
        )
        .await
        .unwrap();
        let item = Mission::items(&pool, other.id).await.unwrap().remove(0);
        assert_eq!(item.fields.get("goal").map(String::as_str), Some("g"));
        assert_eq!(item.fields.get("acceptance").map(String::as_str), Some("a"));
        assert!(!item.fields.contains_key("scope"));

        // set_mission and get_brief with mission_id.
        call_tool(
            &pool,
            here,
            "set_mission",
            &json!({ "mission_id": target, "title": "Login nuevo" }),
        )
        .await
        .unwrap();
        assert_eq!(
            Mission::find_by_id(&pool, other.id)
                .await
                .unwrap()
                .unwrap()
                .title,
            "Login nuevo"
        );
        assert_eq!(
            Mission::find_by_id(&pool, own.id)
                .await
                .unwrap()
                .unwrap()
                .title,
            "Landing"
        );
        let brief = call_tool(&pool, here, "get_brief", &json!({ "mission_id": target }))
            .await
            .unwrap();
        assert!(
            brief.contains("Login nuevo") && brief.contains("scope"),
            "{brief}"
        );

        // remove_item with mission_id.
        call_tool(
            &pool,
            here,
            "remove_item",
            &json!({ "mission_id": target, "item_id": item_id }),
        )
        .await
        .unwrap();
        assert!(Mission::items(&pool, other.id).await.unwrap().is_empty());
    }

    /// One chat per mission, one Fluke for all: every chat sees every open
    /// mission, marks its own, and never lists the standing conversation.
    #[tokio::test]
    async fn every_chat_knows_every_mission() {
        let pool = brief_pool().await;
        let (_, landing) = conversation(&pool, "Landing").await;
        let (_, login) = conversation(&pool, "Login").await;
        let (_, guard) = conversation(&pool, "Fluke").await;
        FlukeGuard::set(&pool, guard.id).await.unwrap();

        let block = missions_block(&pool, landing.id).await.unwrap();
        assert!(block.starts_with("\n\n[MISSIONS]\n"), "{block}");
        assert!(block.contains(&format!("\"Landing\" (id {}", landing.id)), "{block}");
        assert!(block.contains(", this chat)"), "{block}");
        assert!(block.contains(&format!("\"Login\" (id {}", login.id)), "{block}");
        assert!(!block.contains("\"Fluke\""), "{block}");
        assert_eq!(block.matches("this chat").count(), 1);

        // From the standing conversation none is "this chat".
        let block = missions_block(&pool, guard.id).await.unwrap();
        assert!(!block.contains("this chat"), "{block}");
    }

    #[tokio::test]
    async fn brief_tools_without_mission_id_keep_their_mission() {
        let pool = brief_pool().await;
        let (here, own) = conversation(&pool, "Landing").await;
        let (_, other) = conversation(&pool, "Login").await;
        call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "kind": "bug", "title": "Botón roto" }),
        )
        .await
        .unwrap();
        assert_eq!(Mission::items(&pool, own.id).await.unwrap().len(), 1);
        assert!(Mission::items(&pool, other.id).await.unwrap().is_empty());

        // The standing conversation has no mission of its own: it needs an id.
        let (guard_session, guard) = conversation(&pool, "Fluke").await;
        FlukeGuard::set(&pool, guard.id).await.unwrap();
        let err = call_tool(&pool, guard_session, "get_brief", &json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("need mission_id"), "{err}");
        call_tool(
            &pool,
            guard_session,
            "upsert_item",
            &json!({ "mission_id": other.id.to_string(), "kind": "design", "title": "Logo" }),
        )
        .await
        .unwrap();
        assert_eq!(Mission::items(&pool, other.id).await.unwrap().len(), 1);
        // Any chat can act on any mission with its id.
        call_tool(
            &pool,
            guard_session,
            "upsert_item",
            &json!({ "mission_id": own.id.to_string(), "kind": "design", "title": "Hero" }),
        )
        .await
        .unwrap();
        assert_eq!(Mission::items(&pool, own.id).await.unwrap().len(), 2);
        assert_eq!(Mission::items(&pool, other.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn brief_tools_reject_bad_targets_and_items() {
        let pool = brief_pool().await;
        let (here, own) = conversation(&pool, "Landing").await;
        let (_, other) = conversation(&pool, "Login").await;
        let target = other.id.to_string();
        call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "kind": "bug", "title": "Propio" }),
        )
        .await
        .unwrap();
        let own_item = Mission::items(&pool, own.id).await.unwrap()[0].id;

        // An item of another mission is unknown here, and nothing is written.
        let err = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "item_id": own_item, "kind": "bug", "title": "x" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "unknown item_id");
        let err = call_tool(
            &pool,
            here,
            "remove_item",
            &json!({ "mission_id": target, "item_id": own_item }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "unknown item_id");
        assert!(Mission::items(&pool, other.id).await.unwrap().is_empty());
        assert_eq!(
            Mission::items(&pool, own.id).await.unwrap()[0].title,
            "Propio"
        );

        // Invalid kind or field: rejected before writing.
        let err = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "kind": "epic" }),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("kind must be one of"), "{err}");
        let err = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "kind": "bug", "fields": { "goal": "g" } }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown field 'goal'"), "{err}");
        assert!(Mission::items(&pool, other.id).await.unwrap().is_empty());

        // Invalid, unknown, standing-conversation and closed missions.
        let err = call_tool(&pool, here, "get_brief", &json!({ "mission_id": "login" }))
            .await
            .unwrap_err();
        assert!(err.contains("invalid mission_id"), "{err}");
        let err = call_tool(
            &pool,
            here,
            "get_brief",
            &json!({ "mission_id": Uuid::new_v4().to_string() }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("no mission with id"), "{err}");
        let (_, guard) = conversation(&pool, "Fluke").await;
        FlukeGuard::set(&pool, guard.id).await.unwrap();
        let err = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": guard.id.to_string(), "kind": "bug" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("standing conversation"), "{err}");
        Mission::set_status(&pool, other.id, mission::STATUS_CLOSED)
            .await
            .unwrap();
        let err = call_tool(
            &pool,
            here,
            "upsert_item",
            &json!({ "mission_id": target, "kind": "bug" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("closed"), "{err}");
        call_tool(&pool, here, "get_brief", &json!({ "mission_id": target }))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn set_mission_keeps_the_repo_of_a_sent_brief() {
        let pool = brief_pool().await;
        let (here, _) = conversation(&pool, "Landing").await;
        let (_, other) = conversation(&pool, "Login").await;
        let repo = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name) VALUES (?, '/r/web', 'web', 'Web')",
        )
        .bind(repo)
        .execute(&pool)
        .await
        .unwrap();
        Mission::set_analyst_task(&pool, other.id, Uuid::new_v4())
            .await
            .unwrap();
        let err = call_tool(
            &pool,
            here,
            "set_mission",
            &json!({ "mission_id": other.id.to_string(), "repo": "web", "title": "Otro" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("repo can't change"), "{err}");
        let m = Mission::find_by_id(&pool, other.id).await.unwrap().unwrap();
        assert_eq!((m.title.as_str(), m.repo_id), ("Login", other.repo_id));
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

    #[tokio::test]
    async fn memory_reaches_the_turn_but_not_event_batches() {
        use db::models::fluke_memory::FlukeMemory;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();

        assert_eq!(memory_block(&pool, Some("hola")).await.unwrap(), "");
        let id = FlukeMemory::remember(&pool, "Prefiere device flow para los logins", "preference")
            .await
            .unwrap();
        let block = memory_block(&pool, Some("armemos el login")).await.unwrap();
        assert_eq!(
            block,
            format!("\n\n[MEMORY]\n- #{id} (preference) Prefiere device flow para los logins")
        );
        assert_eq!(FlukeMemory::list(&pool).await.unwrap()[0].uses, 1);
        assert_eq!(
            memory_block(&pool, Some("[EVENTS]\n- 09:31 task.failed")).await.unwrap(),
            ""
        );
        assert_eq!(memory_block(&pool, None).await.unwrap(), "");
    }

    #[test]
    fn turn_events_from_the_cli_stream() {
        assert_eq!(
            turn_event(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Dale, "}}}"#),
            Some(TurnEvent::Delta("Dale, ".into()))
        );
        // Thinking and tool input deltas are not the reply.
        assert_eq!(
            turn_event(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}"#),
            None
        );
        assert_eq!(
            turn_event(r#"{"type":"result","subtype":"success","is_error":false,"result":"Listo."}"#),
            Some(TurnEvent::Done { text: "Listo.".into(), is_error: false })
        );
        assert_eq!(turn_event(r#"{"type":"assistant","message":{}}"#), None);
        assert_eq!(turn_event("not json"), None);

        let mission = Uuid::new_v4();
        assert!(!take_voice_turn(mission));
        mark_voice_turn(mission);
        assert!(take_voice_turn(mission));
        assert!(!take_voice_turn(mission), "only the next turn");
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

    /// #799: Fluke merges a PR only through the endpoint the button uses, and
    /// only after the user's own yes.
    #[test]
    fn merging_a_pr_waits_for_the_users_yes() {
        use reqwest::Method;
        let repo = Uuid::new_v4();
        let path = format!("/api/repos/{repo}/pull-requests/675/merge");
        assert!(confirmations::is_dangerous(&Method::POST, &path));
        assert!(confirmations::is_dangerous(&Method::POST, "/api/repos/fluke/pull-requests/675/merge"));
        assert!(!confirmations::is_dangerous(&Method::GET, &path));

        // Cancelled: nothing is left to run later.
        let mission = Uuid::new_v4();
        let args = json!({"method": "POST", "path": path, "summary": "mergear el PR #675"});
        let token = confirmations::hold(mission, args.clone());
        confirmations::on_user_message(mission, "Cancelar");
        assert!(confirmations::take_approved(mission, token).is_err());

        // Confirmed: the held call runs once. If the endpoint then refuses
        // the merge, the confirmation is already spent and nothing retries it.
        let token = confirmations::hold(mission, args);
        confirmations::on_user_message(mission, "Sí, mergear el PR #675");
        assert_eq!(confirmations::take_approved(mission, token).unwrap()["path"], path);
        assert!(confirmations::take_approved(mission, token).is_err());

        assert!(SYSTEM_PROMPT.contains("/pull-requests/{number}/merge"));
        assert!(SYSTEM_PROMPT.contains("never retry it"));
    }

    /// #780: approving another mission's brief from this conversation goes
    /// through the same gate, held under the conversation's mission.
    #[test]
    fn approving_another_missions_brief_waits_for_the_users_yes() {
        use reqwest::Method;
        let conversation = Uuid::new_v4();
        let other = Uuid::new_v4();
        let path = format!("/api/missions/{other}/approve");
        assert!(confirmations::is_dangerous(&Method::POST, &path));
        assert_eq!(approve_target(&Method::POST, &path), Some(other));
        assert_eq!(approve_target(&Method::POST, &format!("{path}/?x=1")), Some(other));
        assert_eq!(approve_target(&Method::GET, &path), None);
        assert_eq!(approve_target(&Method::POST, "/api/missions/x/approve"), None);
        assert_eq!(approve_target(&Method::POST, &format!("/api/missions/{other}")), None);

        // The confirmation names the target mission and the Analyst.
        assert_eq!(
            approve_summary(None, Some("Landing"), "POST missions approve"),
            "aprobar el brief de «Landing» y mandarlo al Analyst"
        );
        assert_eq!(
            approve_summary(Some("aprobar el brief".into()), Some("Landing"), "x"),
            "aprobar el brief (brief de «Landing», al Analyst)"
        );
        assert_eq!(
            approve_summary(Some("mandar landing al Analyst".into()), Some("Landing"), "x"),
            "mandar landing al Analyst"
        );
        assert_eq!(approve_summary(None, None, "POST missions approve"), "POST missions approve");

        // Hold -> the user's yes -> the held call targets the other mission.
        let call = json!({"method": "POST", "path": path, "body": {}});
        let token = confirmations::hold(conversation, call.clone());
        assert!(confirmations::take_approved(conversation, token).is_err());
        // A pending call is not reachable through the target mission's id.
        confirmations::on_user_message(other, "sí");
        assert!(confirmations::take_approved(other, token).is_err());
        confirmations::on_user_message(conversation, "sí, mandalo");
        assert!(confirmations::take_approved(conversation, Uuid::new_v4()).is_err());
        assert_eq!(confirmations::take_approved(conversation, token).unwrap(), call);
        assert!(confirmations::take_approved(conversation, token).is_err());

        // Anything but a yes cancels it.
        let token = confirmations::hold(conversation, call.clone());
        confirmations::on_user_message(conversation, "mejor no");
        assert!(confirmations::take_approved(conversation, token).is_err());

        // A second gated call replaces the first one.
        let first = confirmations::hold(conversation, call.clone());
        let second = confirmations::hold(conversation, json!({"method": "DELETE", "path": "/api/workers/x"}));
        confirmations::on_user_message(conversation, "sí");
        assert!(confirmations::take_approved(conversation, first).is_err());
        assert_eq!(
            confirmations::take_approved(conversation, second).unwrap()["method"],
            "DELETE"
        );
    }

    #[test]
    fn api_reference_finds_endpoints_and_types() {
        assert!(api_reference("").contains("/api/workers"));
        let hit = api_reference("ReassignWorkerTaskRequest");
        assert!(hit.contains("--- api.ts:") && hit.contains("reassign"));
        assert!(api_reference("zz-no-such-thing").starts_with("nothing matches"));
        let items = api_reference("items");
        assert!(
            items.contains("/api/missions/${id}/items`") && items.contains("'DELETE'"),
            "{items}"
        );
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

    fn proposed(number: i64, state: &str, design: bool) -> MissionProposalIssue {
        MissionProposalIssue {
            number,
            title: "t".into(),
            state: state.into(),
            milestone: Some("M".into()),
            wave: Some(0),
            decision: false,
            design,
        }
    }

    #[test]
    fn delivery_tells_design_ready_from_implemented() {
        // No design issues (or missions from before the label): no reading.
        assert_eq!(delivery(&[proposed(1, "closed", false)], 1, "none"), None);
        // Design still open: not ready yet.
        let open_design = [proposed(1, "open", true), proposed(2, "open", false)];
        assert_eq!(delivery(&open_design, 2, "none"), None);
        // Design closed, no implementation issue yet.
        let only_design = [proposed(1, "closed", true)];
        assert_eq!(delivery(&only_design, 1, "none"), Some("design_ready"));
        // Design closed, implementation open: ready until it is dispatched.
        let pending = [proposed(1, "closed", true), proposed(2, "open", false)];
        assert_eq!(delivery(&pending, 2, "none"), Some("design_ready"));
        assert_eq!(delivery(&pending, 2, "planning"), Some("implementing"));
        assert_eq!(delivery(&pending, 2, "running"), Some("implementing"));
        // Implementation closed.
        let done = [proposed(1, "closed", true), proposed(2, "closed", false)];
        assert_eq!(delivery(&done, 2, "running"), Some("implemented"));
        // An issue missing from the mirror is never read as implemented.
        assert_eq!(delivery(&done, 3, "running"), Some("design_ready"));
    }

    #[test]
    fn closed_design_gets_an_implementation_issue_once() {
        // The normal flow: the designer opens no PR, the mock lives in the
        // pushed `design/*` ref.
        let delivered = ClosedDesignIssue {
            number: 12,
            title: "Mock del carrito".into(),
            wave: Some(0),
            deliverable_ref: Some("design/12-carrito".into()),
            paths: vec!["design/carrito.html".into()],
            ..Default::default()
        };
        let s = closed_designs_section(std::slice::from_ref(&delivered));
        assert!(s.contains("#12") && s.contains("No los edites"));
        assert!(s.contains("rama `design/12-carrito`") && s.contains("`design/carrito.html`"));
        assert!(s.contains("`wave:1` o posterior"));
        assert!(s.contains(&implements_design_marker(12)));
        assert!(!s.contains("pregunta abierta") && !s.contains("PR #"));

        // A merged PR is linked too.
        let merged = ClosedDesignIssue {
            prs: vec![MockPr {
                number: 30,
                url: "https://github.com/o/r/pull/30".into(),
                merged: true,
            }],
            ..delivered.clone()
        };
        let s = closed_designs_section(std::slice::from_ref(&merged));
        assert!(s.contains("Mock mergeado en el PR #30") && !s.contains("pregunta abierta"));

        // Already implemented: no new issue is asked for.
        let done = ClosedDesignIssue {
            implemented_by: vec![40],
            ..delivered.clone()
        };
        let s = closed_designs_section(&[done]);
        assert!(s.contains("#40") && s.contains("No crees otro"));
        assert!(!s.contains("Creá un issue nuevo"));

        // Mission issues missing from the mirror are checked before creating.
        let stale = ClosedDesignIssue {
            unverified: vec![41],
            ..delivered.clone()
        };
        let s = closed_designs_section(&[stale]);
        assert!(s.contains("`gh issue view` #41") && s.contains("Creá un issue nuevo"));

        // No merged PR and no artifacts (ref deleted): open question.
        let lost = ClosedDesignIssue {
            prs: vec![MockPr {
                merged: false,
                ..merged.prs[0].clone()
            }],
            paths: vec![],
            ..delivered
        };
        let s = closed_designs_section(&[lost]);
        assert!(s.contains("PR #30 sin mergear") && s.contains("pregunta abierta"));
        assert!(!s.contains("Mock mergeado") && !s.contains("Archivos del mock"));

        assert!(closed_designs_section(&[]).is_empty());
    }

    #[test]
    fn brief_is_complete_only_when_code_says_so() {
        let empty = missing(&mission("", false), &[]);
        assert_eq!(empty, vec!["title", "repo", "items"]);

        let bug = item("bug", &[("symptom", "crashes"), ("steps", "  ")]);
        assert_eq!(
            missing(&mission("Taller", true), &[bug]),
            vec![
                "item:1:steps",
                "item:1:acceptance",
                "item:1:tdd",
                "item:1:architect",
                "item:1:implementer",
                "item:1:reviews",
                "item:1:docs"
            ]
        );

        // TDD has to be decided (#688): "sí", "no" or "no aplica"; so do
        // the optional steps of the plan.
        let feature = item(
            "feature",
            &[
                ("goal", "g"),
                ("scope", "s"),
                ("acceptance", "a"),
                ("tdd", "no aplica"),
                ("architect", "no"),
                ("implementer", "devops"),
                ("reviews", "ninguna"),
                ("docs", "no"),
            ],
        );
        assert!(missing(&mission("Taller", true), &[feature]).is_empty());

        // reference is optional for design
        let design = item("design", &[("goal", "g"), ("scope", "mobile too")]);
        assert!(missing(&mission("Taller", true), &[design]).is_empty());
    }
}
