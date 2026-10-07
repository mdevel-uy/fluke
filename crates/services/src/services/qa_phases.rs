//! Fases del plan de un issue (fluke v2, F3, #687, y perfiles especialistas).
//!
//! An issue opts into the phases with a `<!-- fluke:plan {...} -->` block in
//! its body (written by the Analyst, #688). Without the block the issue is
//! worked exactly as before.
//!
//! Before development (dispatched by the milestone run, `milestone_runs`):
//! - **Arquitectura** (`"architect": true`): the Architect commits an ADR and
//!   its branch is pushed as `arch/<issue>-<slug>`.
//! - **Tests primero** (`template: "tdd"`): QA commits failing tests, pushed
//!   as `tdd/<issue>-<slug>`.
//!
//! Each phase starts from the branch of the one before, and the developer
//! (or DevOps, `"implementer": "devops"`) from the last one
//! (`worker_tasks.start_ref`).
//!
//! Gates before the review, in [`Gate::ORDER`]: when the PR's CI is green the
//! review is not dispatched until every gate the plan asks for passed.
//! - **Documentación** (on by default, `"docs": false` turns it off): once per
//!   PR, Docs commits on the PR branch and the system pushes it. The head
//!   moves, so the next gates run on the documented code.
//! - **Testing** (any plan block), **Calidad** and **Seguridad**
//!   (`"reviews": ["quality", "security"]`): per PR head, the profile writes
//!   its verdict to `.vk/<gate>.json`; pass moves on to the next gate or the
//!   review, fail sends the reasons back to the developer through the same
//!   follow-up path a request_changes uses. A new push moves the head, so
//!   the gate runs again, up to [`MAX_GATE_FAILURES`] failures per PR.

use std::{path::PathBuf, sync::Arc};

use db::{
    DBService,
    models::{
        pull_request::PullRequest,
        repo::Repo,
        repo_issue::RepoIssue,
        worker::{self, Worker},
        worker_task::{self, CreateWorkerTask, WorkerTask},
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::services::{config::Config, container::ContainerService, worker_orchestrator};

pub const QA_JSON_RELATIVE_PATH: &str = ".vk/qa.json";

pub const GATE_JSON_EXAMPLE: &str = r#"{"verdict":"pass","reasons":""}"#;

pub fn gate_prompt_contract(path: &str) -> String {
    format!(
        "[GATE DELIVERABLE]\nEscribí `{path}` en la raíz del repo/worktree (donde vive `.git`); creá `.vk` si falta. Está permitido escribir este archivo de control aunque tu rol no modifique código. No lo commitees.\n\
         Esquema: objeto JSON con `verdict` (string: `pass` o `fail`) y `reasons` (string opcional, por defecto vacío). Para fail describí los hallazgos y cómo reproducirlos; no inventes un pass.\n\
         Ejemplo JSON válido (usá tu resultado real):\n```json\n{GATE_JSON_EXAMPLE}\n```\n\
         Archivo ausente, JSON inválido o esquema incorrecto son errores de entrega, no un fail funcional."
    )
}
pub const TEMPLATE_TDD: &str = "tdd";
pub const VERDICT_PASS: &str = "pass";
pub const VERDICT_FAIL: &str = "fail";
/// The profile finished without a readable verdict: the issue stops here,
/// visible as stuck in its plan, instead of bouncing an invented failure to
/// the dev.
pub const VERDICT_ERROR: &str = "error";
/// Failed verdicts of one gate on a PR before the loop stops for a person.
pub const MAX_GATE_FAILURES: i64 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlanTemplate {
    pub tdd: bool,
    pub testing: bool,
    pub docs: bool,
    /// Slugs of the profiles the plan asks for before development.
    pub pre: Vec<String>,
    /// Slug of the profile that implements; `None` = a developer.
    pub implementer: Option<String>,
    /// Slugs of the gate profiles the plan asks for before the review.
    pub reviews: Vec<String>,
}

#[derive(Deserialize)]
struct PlanBlock {
    template: Option<String>,
    /// Older plans ask for the Architect with a flag; it is the profile
    /// `architect` before development.
    #[serde(default)]
    architect: bool,
    #[serde(default)]
    pre: Vec<String>,
    implementer: Option<String>,
    #[serde(default)]
    reviews: Vec<String>,
    docs: Option<bool>,
}

/// The issue's phase template, read from its `fluke:plan` block. `None`
/// when the body has no (valid) block: the issue keeps today's flow.
pub fn plan_template(body: Option<&str>) -> Option<PlanTemplate> {
    let body = body?;
    let at = body.find("fluke:plan")?;
    if !body[..at].trim_end().ends_with("<!--") {
        return None;
    }
    let rest = &body[at + "fluke:plan".len()..];
    let end = rest.find("-->")?;
    let block: PlanBlock = serde_json::from_str(rest[..end].trim()).ok()?;
    let slugs = |list: Vec<String>| -> Vec<String> {
        list.iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut pre = slugs(block.pre);
    if block.architect && !pre.iter().any(|s| s == "architect") {
        pre.insert(0, "architect".to_string());
    }
    Some(PlanTemplate {
        tdd: block.template.as_deref() == Some(TEMPLATE_TDD),
        testing: true,
        docs: block.docs.unwrap_or(true),
        pre,
        implementer: block
            .implementer
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty() && s != worker::ROLE_DEVELOPER),
        reviews: slugs(block.reviews),
    })
}

/// A phase that has to pass before the review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Commits on the PR branch, once per PR.
    Docs,
    /// QA validates the PR.
    Testing,
    /// A gate profile of the flow reviews the PR and writes a verdict.
    Review { slug: String, label: String },
}

impl Gate {
    pub fn review(slug: &str, label: &str) -> Gate {
        Gate::Review {
            slug: slug.to_string(),
            label: label.to_string(),
        }
    }

    pub fn kind(&self) -> String {
        match self {
            Gate::Docs => worker_task::KIND_DOCS.to_string(),
            Gate::Testing => worker_task::KIND_QA_TEST.to_string(),
            Gate::Review { slug, .. } => worker_task::gate_kind(slug),
        }
    }

    /// The gate of a task of `kind`; `label` names a review gate (the
    /// profile that ran it).
    pub fn from_kind(kind: Option<&str>, label: &str) -> Option<Gate> {
        match kind? {
            worker_task::KIND_DOCS => Some(Gate::Docs),
            worker_task::KIND_QA_TEST => Some(Gate::Testing),
            k @ (worker_task::KIND_QUALITY | worker_task::KIND_SECURITY) => {
                Some(Gate::review(k, label))
            }
            k => k
                .strip_prefix(worker_task::GATE_KIND_PREFIX)
                .map(|slug| Gate::review(slug, label)),
        }
    }

    /// Kind of the gate's phase in the issue plan.
    pub fn phase_kind(&self) -> String {
        match self {
            Gate::Docs => "docs".to_string(),
            Gate::Testing => "test".to_string(),
            Gate::Review { .. } => self.kind(),
        }
    }

    /// Where the profile writes its verdict. Docs has none: it commits.
    pub fn verdict_path(&self) -> Option<String> {
        match self {
            Gate::Docs => None,
            Gate::Testing => Some(QA_JSON_RELATIVE_PATH.to_string()),
            Gate::Review { slug, .. } => Some(format!(".vk/{slug}.json")),
        }
    }

    fn label(&self) -> &str {
        match self {
            Gate::Docs => "Documentación",
            Gate::Testing => "Testing",
            Gate::Review { label, .. } => label,
        }
    }

    fn prompt(&self, pr_number: i64, pr_title: &str, head_sha: &str) -> String {
        match self {
            Gate::Docs => docs_prompt(pr_number, pr_title),
            Gate::Testing => test_prompt(pr_number, head_sha),
            Gate::Review { .. } => review_gate_prompt(self, pr_number, head_sha),
        }
    }
}

/// Whether a phase kind of the issue plan is a gate before the review.
pub fn is_gate_phase(kind: &str) -> bool {
    matches!(kind, "docs" | "test") || worker_task::is_pr_keyed_kind(Some(kind))
}

/// First active profile with `role`.
pub async fn profile_for(pool: &SqlitePool, role: &str) -> Result<Option<Worker>, sqlx::Error> {
    Ok(Worker::list_all(pool)
        .await?
        .into_iter()
        .find(|w| w.role == role))
}

/// Profiles of `stage` that run on an issue with `plan`: the ones that
/// always do and the ones the plan names, in their order in the flow.
async fn stage_profiles(
    pool: &SqlitePool,
    stage: &str,
    asked: &[String],
) -> Result<Vec<(Worker, String)>, sqlx::Error> {
    let flow = Worker::list_flow(pool).await?;
    for slug in asked {
        if !flow
            .iter()
            .any(|(_, f)| f.stage.as_deref() == Some(stage) && f.slug.as_ref() == Some(slug))
        {
            warn!(
                slug,
                stage, "The plan asks for a profile that is not in the flow; skipping it"
            );
        }
    }
    Ok(flow
        .into_iter()
        .filter(|(_, f)| f.stage.as_deref() == Some(stage))
        .filter_map(|(w, f)| {
            let slug = f.slug?;
            (f.always || asked.contains(&slug)).then_some((w, slug))
        })
        .collect())
}

/// The gates of an issue with `plan`, in order: Docs, Testing, then the
/// gate profiles of the flow. A gate without an active profile is left out.
pub async fn plan_gates(
    pool: &SqlitePool,
    plan: &PlanTemplate,
) -> Result<Vec<(Gate, Worker)>, sqlx::Error> {
    let mut out = Vec::new();
    for (gate, role, wanted) in [
        (Gate::Docs, worker::ROLE_DOCS, plan.docs),
        (Gate::Testing, worker::ROLE_QA, plan.testing),
    ] {
        if !wanted {
            continue;
        }
        match profile_for(pool, role).await? {
            Some(profile) => out.push((gate, profile)),
            None => warn!(
                role,
                "The plan asks for a gate without an active profile; skipping it"
            ),
        }
    }
    for (profile, slug) in stage_profiles(pool, worker::STAGE_GATE, &plan.reviews).await? {
        out.push((Gate::review(&slug, &profile.name), profile));
    }
    Ok(out)
}

/// A phase before development: commits on a branch the next phase (or the
/// developer) starts from.
#[derive(Debug, Clone)]
pub struct PreDevPhase {
    pub kind: String,
    pub profile: Worker,
}

impl PreDevPhase {
    /// Title and prompt of the phase's task for the issue.
    pub fn task(&self, number: i64, title: &str, body: Option<&str>) -> (String, String) {
        match self.kind.as_str() {
            worker_task::KIND_ARCH => (
                format!("Arquitectura #{number} {title}"),
                arch_prompt(number, title, body),
            ),
            worker_task::KIND_QA_TDD => (
                format!("Tests #{number} {title}"),
                tdd_prompt(number, title, body),
            ),
            _ => (
                format!("{} #{number} {title}", self.profile.name),
                pre_dev_prompt(&self.profile.name, number, title, body),
            ),
        }
    }
}

/// The phases before development of an issue with `plan`, in order: the
/// profiles of the flow, then QA's tests first, right before the code.
pub async fn pre_dev_phases(
    pool: &SqlitePool,
    plan: &PlanTemplate,
) -> Result<Vec<PreDevPhase>, sqlx::Error> {
    let mut out: Vec<PreDevPhase> = stage_profiles(pool, worker::STAGE_PRE_DEV, &plan.pre)
        .await?
        .into_iter()
        .map(|(profile, slug)| PreDevPhase {
            kind: worker_task::pre_dev_kind(&slug),
            profile,
        })
        .collect();
    if plan.tdd {
        match profile_for(pool, worker::ROLE_QA).await? {
            Some(profile) => out.push(PreDevPhase {
                kind: worker_task::KIND_QA_TDD.to_string(),
                profile,
            }),
            None => {
                warn!("The plan asks for tests first without an active QA profile; skipping it")
            }
        }
    }
    Ok(out)
}

/// The profile that implements an issue whose plan names `slug`, if it is
/// an active implementer of the flow.
pub async fn implementer_for(pool: &SqlitePool, slug: &str) -> Result<Option<Worker>, sqlx::Error> {
    Ok(Worker::list_flow(pool)
        .await?
        .into_iter()
        .find(|(w, f)| {
            f.stage.as_deref() == Some(worker::STAGE_IMPLEMENT)
                && f.slug.as_deref() == Some(slug)
                && worker::is_implementer(&w.role)
        })
        .map(|(w, _)| w))
}

/// The optional profiles of the flow, one line each, for Fluke and the
/// Analyst: how the plan names them and when to offer them.
pub async fn flow_catalog(pool: &SqlitePool) -> Result<String, sqlx::Error> {
    let mut lines = Vec::new();
    for (w, f) in Worker::list_flow(pool).await? {
        let (Some(slug), Some(stage)) = (f.slug, f.stage) else {
            continue;
        };
        let (field, place) = match stage.as_str() {
            worker::STAGE_PRE_DEV => ("pre", "antes del desarrollo"),
            worker::STAGE_IMPLEMENT => ("implementer", "implementa"),
            _ => ("reviews", "compuerta antes del review"),
        };
        let when = if f.always {
            "corre siempre, no hace falta pedirlo".to_string()
        } else {
            match f.offer_when {
                Some(w) => format!("ofrecerlo cuando: {w}"),
                None => "solo si el user lo pide".to_string(),
            }
        };
        lines.push(format!(
            "- {} (slug \"{slug}\", {place}, campo \"{field}\"): {when}",
            w.name
        ));
    }
    Ok(lines.join("\n"))
}

pub fn tdd_prompt(number: i64, title: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).unwrap_or("");
    format!(
        "Fase Tests primero del issue #{number}: {title}\n\n{body}\n\n\
         Escribí los tests que prueban los criterios de aceptación de este issue ANTES de que \
         exista el código. Tienen que fallar porque la funcionalidad todavía no está, no por \
         errores evitables. No implementes la funcionalidad. Commiteá solo los tests en esta rama: \
         el desarrollador va a continuar desde acá. Antes de empezar, corré \
         `gh issue view {number} --comments`."
    )
}

pub fn arch_prompt(number: i64, title: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).unwrap_or("");
    format!(
        "Fase Arquitectura del issue #{number}: {title}\n\n{body}\n\n\
         Analizá el issue y el código existente y escribí el ADR con la propuesta de \
         arquitectura y el plan de implementación. No implementes la funcionalidad. Commiteá \
         solo el ADR en esta rama: las fases siguientes continúan desde acá. Antes de empezar, \
         corré `gh issue view {number} --comments`."
    )
}

pub fn test_prompt(pr_number: i64, head_sha: &str) -> String {
    let contract = gate_prompt_contract(QA_JSON_RELATIVE_PATH);
    format!(
        "Fase Testing del PR #{pr_number} (commit {head_sha}).\n\n\
         Validá el PR contra lo que promete el issue que cierra (`gh pr view {pr_number}`, \
         `gh pr diff {pr_number}`). Los checks (tests, typecheck, lint) los corre el CI: miralos con \
         `gh pr checks {pr_number}` y si alguno falla es fail. No instales dependencias ni corras \
         builds, tests o typechecks vos: el worktree no tiene `node_modules` ni caché de build. \
         No modifiques código ni commitees.\n\n\
         {contract}"
    )
}

pub fn pre_dev_prompt(name: &str, number: i64, title: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).unwrap_or("");
    format!(
        "Fase {name} del issue #{number}: {title}\n\n{body}\n\n\
         Trabajás antes del desarrollo, según tu rol. No implementes la funcionalidad. \
         Commiteá tu entrega en esta rama: las fases siguientes y el desarrollador continúan \
         desde acá. Antes de empezar, corré `gh issue view {number} --comments`."
    )
}

fn review_gate_prompt(gate: &Gate, pr_number: i64, head_sha: &str) -> String {
    let label = gate.label();
    let path = gate.verdict_path().unwrap_or_default();
    let contract = gate_prompt_contract(&path);
    format!(
        "Fase {label} del PR #{pr_number} (commit {head_sha}).\n\n\
         Revisá el PR según tu rol (`gh pr view {pr_number}`, `gh pr diff {pr_number}`); el \
         worktree está en ese commit para que leas el código alrededor del diff. No modifiques \
         código ni commitees. No instales dependencias ni corras builds, tests o typechecks.\n\n\
         Registrá cada hallazgo con archivo, línea y corrección propuesta en reasons; \
         las sugerencias menores también van acá.\n\n\
         {contract}"
    )
}

fn docs_prompt(pr_number: i64, pr_title: &str) -> String {
    format!(
        "Fase Documentación del PR #{pr_number}: {pr_title}\n\n\
         Estás en la rama del PR. Leé el PR y el issue que cierra (`gh pr view {pr_number}`, \
         `gh pr diff {pr_number}`) y actualizá la documentación que ese cambio afecta. Commiteá \
         en esta rama: el sistema sube tus commits al PR. No toques código de la aplicación ni \
         corras builds o tests. Si no hay nada que documentar, no commitees."
    )
}

/// What the gates decide for a PR head.
#[derive(Debug)]
pub enum GateStep {
    /// No plan, or every gate the plan asks for passed: the review may start.
    Proceed,
    /// A gate is running on this head, failed it and the fix has not been
    /// pushed yet, or failed too many times.
    Hold,
    /// This gate has not seen this head: dispatch it to this profile.
    Dispatch(Gate, Worker),
}

/// Where one gate stands for a PR head.
async fn gate_state(
    pool: &SqlitePool,
    gate: &Gate,
    repo_id: Uuid,
    pr_number: i64,
    head_sha: &str,
) -> Result<Option<bool>, sqlx::Error> {
    // Some(true) = passed, Some(false) = hold, None = dispatch.
    let latest = WorkerTask::latest_gate_for_pr(pool, repo_id, pr_number, &gate.kind()).await?;
    if *gate == Gate::Docs {
        // Once per PR: a later push of a fix does not document again.
        return Ok(latest.map(|(_, status, _, _)| status == worker_task::STATUS_DONE));
    }
    if let Some((_, status, head, verdict)) = latest {
        if head.as_deref() == Some(head_sha) {
            return Ok(Some(
                status == worker_task::STATUS_DONE && verdict.as_deref() == Some(VERDICT_PASS),
            ));
        }
        if matches!(status.as_str(), "queued" | "in_progress") {
            return Ok(Some(false));
        }
        if WorkerTask::count_failed_gates_for_pr(pool, repo_id, pr_number, &gate.kind()).await?
            >= MAX_GATE_FAILURES
        {
            warn!(
                pr_number,
                gate = %gate.kind(),
                "Gate failed {MAX_GATE_FAILURES} times on this PR; waiting for a person"
            );
            return Ok(Some(false));
        }
    }
    Ok(None)
}

pub async fn next_gate(
    pool: &SqlitePool,
    repo_id: Uuid,
    pr_number: i64,
    head_sha: &str,
) -> Result<GateStep, sqlx::Error> {
    let Some(ws) = PullRequest::find_latest_workspace_for_pr(pool, repo_id, pr_number).await?
    else {
        return Ok(GateStep::Proceed);
    };
    let Some(dev) = WorkerTask::find_by_workspace(pool, ws).await? else {
        return Ok(GateStep::Proceed);
    };
    let Some(issue_number) = dev.issue_number else {
        return Ok(GateStep::Proceed);
    };
    let Some(issue) = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number).await? else {
        return Ok(GateStep::Proceed);
    };
    let Some(plan) = plan_template(issue.body.as_deref()) else {
        return Ok(GateStep::Proceed);
    };

    for (gate, profile) in plan_gates(pool, &plan).await? {
        match gate_state(pool, &gate, repo_id, pr_number, head_sha).await? {
            Some(true) => continue,
            Some(false) => return Ok(GateStep::Hold),
            None => return Ok(GateStep::Dispatch(gate, profile)),
        }
    }
    Ok(GateStep::Proceed)
}

/// Queue a gate task for a PR head on `profile`.
pub async fn queue_gate(
    pool: &SqlitePool,
    gate: &Gate,
    profile: &Worker,
    repo_id: Uuid,
    pr_number: i64,
    pr_title: &str,
    head_sha: &str,
) -> Result<WorkerTask, sqlx::Error> {
    let task = WorkerTask::append(
        pool,
        profile.id,
        &CreateWorkerTask {
            repo_id,
            title: format!("{} PR #{pr_number}: {pr_title}", gate.label()),
            prompt: gate.prompt(pr_number, pr_title, head_sha),
            issue_number: Some(pr_number),
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        },
    )
    .await?;
    WorkerTask::set_kind(pool, task.id, &gate.kind()).await?;
    WorkerTask::set_qa_result(pool, task.id, Some(head_sha), None).await?;
    Ok(task)
}

/// Gates, called by `dispatch_review_task` for automatic dispatches. `true`
/// when the review may start; otherwise it makes sure the pending gate is
/// running (or waiting for the fix) for `head_sha` and returns `false`.
pub async fn review_may_start(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    repo_id: Uuid,
    pr_number: i64,
    pr_title: &str,
    head_sha: &str,
) -> Result<bool, sqlx::Error> {
    match next_gate(&db.pool, repo_id, pr_number, head_sha).await? {
        GateStep::Proceed => Ok(true),
        GateStep::Hold => Ok(false),
        GateStep::Dispatch(gate, profile) => {
            queue_gate(
                &db.pool, &gate, &profile, repo_id, pr_number, pr_title, head_sha,
            )
            .await?;
            info!(
                pr_number,
                head_sha,
                gate = %gate.kind(),
                "Gate dispatched before review"
            );
            worker_orchestrator::kickstart_stuck_worker_queues(config, db, container).await?;
            Ok(false)
        }
    }
}

async fn worktree_path(pool: &SqlitePool, workspace_id: Uuid) -> Option<PathBuf> {
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .ok()
        .flatten()?;
    let container_ref = workspace.container_ref?;
    let workspace_repo = WorkspaceRepo::find_by_workspace_id(pool, workspace_id)
        .await
        .ok()?
        .into_iter()
        .next()?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await
        .ok()
        .flatten()?;
    Some(PathBuf::from(container_ref).join(&repo.name))
}

#[derive(Deserialize)]
struct GateVerdict {
    verdict: String,
    #[serde(default)]
    reasons: String,
}

fn parse_gate_verdict(raw: &str) -> Result<GateVerdict, String> {
    let verdict: GateVerdict = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if verdict.verdict != VERDICT_PASS && verdict.verdict != VERDICT_FAIL {
        return Err("`verdict` debe ser `pass` o `fail`.".to_string());
    }
    Ok(verdict)
}

/// Read and store the verdict of a gate task that just finished, before its
/// worktree is archived. Returns `(verdict, reasons)`.
pub async fn read_gate_verdict(
    pool: &SqlitePool,
    workspace_id: Uuid,
    task: &WorkerTask,
    gate: &Gate,
) -> Option<(String, String)> {
    let path = gate.verdict_path()?;
    let parsed = match worktree_path(pool, workspace_id).await {
        Some(root) => std::fs::read_to_string(root.join(&path))
            .ok()
            .and_then(|raw| parse_gate_verdict(&raw).ok()),
        None => None,
    };
    let (verdict, reasons) = match parsed {
        Some(v) => (v.verdict, v.reasons),
        None => (
            VERDICT_ERROR.to_string(),
            format!("{} no dejó un veredicto válido en {path}.", gate.label()),
        ),
    };
    if let Err(e) = WorkerTask::set_qa_result(pool, task.id, None, Some(&verdict)).await {
        warn!(task_id = %task.id, "Failed to store gate verdict: {}", e);
    }
    if !reasons.trim().is_empty()
        && let Err(e) = WorkerTask::record_deliverable(pool, task.id, Some(&reasons), None).await
    {
        warn!(task_id = %task.id, "Failed to store gate reasons: {}", e);
    }
    Some((verdict, reasons))
}

/// After a gate with a verdict: pass → next gate or the review; fail → send
/// the reasons back to the developer.
pub async fn after_gate(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    task: &WorkerTask,
    gate: &Gate,
    verdict: &str,
    reasons: &str,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let Some(pr_number) = task.issue_number else {
        return Ok(());
    };
    let Some(ws) = PullRequest::find_latest_workspace_for_pr(pool, task.repo_id, pr_number).await?
    else {
        return Ok(());
    };
    let Some(dev) = WorkerTask::find_by_workspace(pool, ws).await? else {
        return Ok(());
    };

    match verdict {
        VERDICT_PASS => {
            worker_orchestrator::dispatch_review_task(
                config,
                db,
                container,
                pr_number,
                &dev.title,
                task.repo_id,
                Some(dev.worker_id),
                false,
            )
            .await
        }
        VERDICT_FAIL => {
            let who = match gate {
                Gate::Testing => "El QA probó".to_string(),
                _ => format!("La revisión de {} revisó", gate.label()),
            };
            let prompt = format!(
                "{who} el PR #{pr_number} y encontró problemas:\n\n{reasons}\n\n\
                 Corregilos en esta misma rama y dejá los checks en verde."
            );
            if worker_orchestrator::dispatch_remediation_follow_up(
                db,
                container,
                pr_number,
                task.repo_id,
                dev.worker_id,
                &prompt,
            )
            .await?
            {
                return Ok(());
            }
            WorkerTask::prepend_review_fix(
                pool,
                dev.worker_id,
                &CreateWorkerTask {
                    repo_id: task.repo_id,
                    title: format!("Fix {} PR #{pr_number}", gate.label()),
                    prompt,
                    issue_number: Some(pr_number),
                    skills: Vec::new(),
                    issue_labels: Vec::new(),
                    source: worker_task::SOURCE_KANBAN.to_string(),
                    territory_globs: Vec::new(),
                },
            )
            .await?;
            worker_orchestrator::kickstart_stuck_worker_queues(config, db, container).await
        }
        _ => Ok(()),
    }
}

/// What the Docs phase left on the PR.
#[derive(Debug, PartialEq, Eq)]
pub enum DocsOutcome {
    /// Commits pushed to the PR branch: the head moved and the PR monitor
    /// resumes the gates once CI is green on it.
    Pushed,
    /// Nothing to document: the gates go on right away.
    Unchanged,
    Failed(String),
}

/// Push the commits of a finished Docs task to its PR's branch, before the
/// worktree is archived, and move the developer's worktree to the new head
/// so its next fix pushes on top of the docs.
pub async fn finish_docs(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    task: &WorkerTask,
    worker: &Worker,
) -> DocsOutcome {
    let pool = &db.pool;
    let git = container.git();
    let (Some(pr_number), Some(docs_path)) =
        (task.issue_number, worktree_path(pool, workspace_id).await)
    else {
        return DocsOutcome::Failed("No encontré el worktree de la fase.".to_string());
    };
    let Ok(Some(dev_ws)) =
        PullRequest::find_latest_workspace_for_pr(pool, task.repo_id, pr_number).await
    else {
        return DocsOutcome::Failed(format!("No encontré el workspace del PR #{pr_number}."));
    };
    let started_at: Option<String> =
        sqlx::query_scalar("SELECT qa_head_sha FROM worker_tasks WHERE id = ?1")
            .bind(task.id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .flatten();
    let head = match git.get_head_info(&docs_path) {
        Ok(h) => h.oid,
        Err(e) => return DocsOutcome::Failed(format!("No pude leer el HEAD: {e}")),
    };
    if started_at.as_deref() == Some(head.as_str()) {
        return DocsOutcome::Unchanged;
    }

    let Ok(Some(docs_ws)) = Workspace::find_by_id(pool, workspace_id).await else {
        return DocsOutcome::Failed("No encontré el workspace de la fase.".to_string());
    };
    let remote_branch = match Workspace::remote_branch_name(pool, dev_ws).await {
        Ok(b) => b,
        Err(e) => return DocsOutcome::Failed(format!("No encontré la rama del PR: {e}")),
    };
    if let Err(e) = git.push_to_remote_with_token(
        &docs_path,
        &docs_ws.branch,
        &remote_branch,
        false,
        worker.github_pat.as_deref(),
    ) {
        return DocsOutcome::Failed(format!(
            "No pude subir la documentación a {remote_branch}: {e}"
        ));
    }
    info!(pr_number, %remote_branch, "Docs pushed to the PR branch");

    // Worktrees of a repo share its objects, so the docs commit is already
    // there. Only fast-forward a clean worktree still on the head Docs
    // started from; anything else is the developer's work, left alone.
    if let Some(dev_path) = worktree_path(pool, dev_ws).await {
        let dev_head = git.get_head_info(&dev_path).ok().map(|h| h.oid);
        if dev_head.is_some() && dev_head == started_at {
            if let Err(e) = git.reset_worktree_to_commit(&dev_path, &head, false) {
                warn!(
                    pr_number,
                    "Could not move the developer worktree to the docs head: {}", e
                );
            }
        } else {
            warn!(
                pr_number,
                "Developer worktree moved since Docs started; not syncing it to the docs head"
            );
        }
    }
    DocsOutcome::Pushed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_contract_examples_use_the_completion_parser() {
        let passed = parse_gate_verdict(GATE_JSON_EXAMPLE).unwrap();
        assert_eq!(passed.verdict, VERDICT_PASS);
        assert!(passed.reasons.is_empty());
        assert!(parse_gate_verdict(r#"{"verdict":"fail","reasons":"Bug reproducible"}"#).is_ok());
        assert!(parse_gate_verdict(r#"{"verdict":"pass"}"#).is_ok());
        for raw in [
            r#"{"verdict":"approve"}"#,
            r#"{"reasons":"missing verdict"}"#,
            r#"{"verdict":true}"#,
            r#"{"verdict":"fail","reasons":[]}"#,
            "not JSON",
        ] {
            assert!(parse_gate_verdict(raw).is_err(), "{raw}");
        }
        assert!(test_prompt(836, "head").contains(&gate_prompt_contract(QA_JSON_RELATIVE_PATH)));
        let gate = Gate::review("security", "Checklist personalizado");
        let prompt = gate.prompt(836, "title", "head");
        assert!(prompt.contains("Checklist personalizado"));
        assert!(prompt.contains(&gate_prompt_contract(".vk/security.json")));
    }

    #[test]
    fn reads_the_plan_block() {
        let body = "## Brief\n\nalgo\n\n<!-- fluke:plan {\"template\":\"tdd\"} -->\n";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                tdd: true,
                testing: true,
                docs: true,
                ..Default::default()
            })
        );
        let body = "<!--fluke:plan {\"template\":\"no_tdd\"}-->";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                testing: true,
                docs: true,
                ..Default::default()
            })
        );
        // Another fluke block before the plan one.
        let body = "<!-- fluke:decision {\"questions\":[]} -->\n<!-- fluke:plan {\"template\":\"tdd\"} -->";
        assert!(plan_template(Some(body)).is_some_and(|t| t.tdd));
    }

    #[test]
    fn reads_the_specialist_phases() {
        let body = "<!-- fluke:plan {\"template\":\"no_tdd\",\"architect\":true,\
                    \"implementer\":\"devops\",\"reviews\":[\"quality\",\"Security\"],\
                    \"docs\":false} -->";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                tdd: false,
                testing: true,
                docs: false,
                pre: vec!["architect".into()],
                implementer: Some("devops".into()),
                reviews: vec!["quality".into(), "security".into()],
            })
        );
        let only_security = "<!-- fluke:plan {\"template\":\"tdd\",\"reviews\":[\"security\"]} -->";
        let t = plan_template(Some(only_security)).unwrap();
        assert_eq!(t.reviews, vec!["security".to_string()]);
        assert!(t.pre.is_empty() && t.implementer.is_none() && t.docs);
    }

    #[test]
    fn reads_profiles_of_the_flow_by_slug() {
        let body = "<!-- fluke:plan {\"template\":\"no_tdd\",\"pre\":[\"data-model\"],\
                    \"architect\":true,\"implementer\":\"developer\",\
                    \"reviews\":[\"Performance\"]} -->";
        let t = plan_template(Some(body)).unwrap();
        assert_eq!(
            t.pre,
            vec!["architect".to_string(), "data-model".to_string()]
        );
        assert_eq!(
            t.implementer, None,
            "developer is the default, not a profile"
        );
        assert_eq!(t.reviews, vec!["performance".to_string()]);
    }

    #[test]
    fn gates_map_to_their_kinds() {
        for gate in [
            Gate::Docs,
            Gate::Testing,
            Gate::review("quality", "Code Quality"),
            Gate::review("security", "Security"),
            Gate::review("performance", "Performance"),
        ] {
            let kind = gate.kind();
            let label = gate.label().to_string();
            assert_eq!(Gate::from_kind(Some(&kind), &label), Some(gate.clone()));
            assert!(worker_task::is_pr_keyed_kind(Some(&kind)));
            assert!(is_gate_phase(&gate.phase_kind()));
        }
        // The profiles that existed keep their kinds and verdict files.
        assert_eq!(Gate::review("security", "S").kind(), "security");
        assert_eq!(
            Gate::review("security", "S").verdict_path().as_deref(),
            Some(".vk/security.json")
        );
        assert_eq!(Gate::review("performance", "P").kind(), "gate:performance");
        assert_eq!(Gate::from_kind(Some(worker_task::KIND_QA_TDD), "QA"), None);
        assert_eq!(Gate::Docs.verdict_path(), None);
        assert!(!is_gate_phase("dev") && !is_gate_phase("pre:data-model"));
    }

    #[test]
    fn no_block_keeps_todays_flow() {
        assert_eq!(plan_template(Some("## Brief\n\nsin bloque")), None);
        assert_eq!(plan_template(Some("<!-- fluke:plan {roto -->")), None);
        assert_eq!(
            plan_template(Some("<!-- fluke:decision {\"questions\":[]} -->")),
            None
        );
        assert_eq!(plan_template(None), None);
    }
}
