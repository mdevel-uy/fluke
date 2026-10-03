//! Fases de QA del issue (fluke v2, F3, #687).
//!
//! An issue opts into the QA phases with a `<!-- fluke:plan {...} -->` block
//! in its body (written by the Analyst, #688). Without the block the issue is
//! worked exactly as before.
//!
//! - **Tests primero** (`template: "tdd"`): the milestone run dispatches a QA
//!   task first; it commits failing tests and its branch is pushed as
//!   `tdd/<issue>-<slug>`. The developer task then starts from that branch
//!   (`worker_tasks.start_ref`).
//! - **Testing** (any plan block): when the PR's CI is green, the review is
//!   not dispatched until QA has validated the PR's current head. QA writes
//!   its verdict to `.vk/qa.json`; pass dispatches the review, fail sends the
//!   reasons back to the developer through the same follow-up path a
//!   request_changes uses. A new push moves the head, so QA runs again.

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
pub const TEMPLATE_TDD: &str = "tdd";
pub const VERDICT_PASS: &str = "pass";
pub const VERDICT_FAIL: &str = "fail";
/// QA finished without a readable verdict: the issue stops here, visible as
/// stuck in its plan, instead of bouncing an invented failure to the dev.
pub const VERDICT_ERROR: &str = "error";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanTemplate {
    pub tdd: bool,
    pub testing: bool,
}

#[derive(Deserialize)]
struct PlanBlock {
    template: Option<String>,
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
    Some(PlanTemplate {
        tdd: block.template.as_deref() == Some(TEMPLATE_TDD),
        testing: true,
    })
}

#[derive(Deserialize)]
struct QaVerdict {
    verdict: String,
    #[serde(default)]
    reasons: String,
}

/// First active QA profile.
pub async fn qa_profile(pool: &SqlitePool) -> Result<Option<Worker>, sqlx::Error> {
    Ok(Worker::list_all(pool)
        .await?
        .into_iter()
        .find(|w| w.role == worker::ROLE_QA))
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

pub fn test_prompt(pr_number: i64, head_sha: &str) -> String {
    format!(
        "Fase Testing del PR #{pr_number} (commit {head_sha}).\n\n\
         Validá el PR contra lo que promete el issue que cierra (`gh pr view {pr_number}`, \
         `gh pr diff {pr_number}`). Los checks (tests, typecheck, lint) ya pasaron: esta fase solo \
         arranca con la verificación automática en verde. No instales dependencias ni corras \
         builds, tests o typechecks vos: el worktree no tiene `node_modules` ni caché de build. \
         No modifiques código ni commitees.\n\n\
         Al terminar escribí tu veredicto en `{QA_JSON_RELATIVE_PATH}` con este formato exacto:\n\
         {{\"verdict\": \"pass\" | \"fail\", \"reasons\": \"qué falló y cómo reproducirlo (vacío si pasa)\"}}"
    )
}

/// What the Testing gate decides for a PR head.
#[derive(Debug)]
pub enum TestingGate {
    /// No plan, no QA profile, or QA passed this head: the review may start.
    Proceed,
    /// QA is on this head, or failed it and the fix has not been pushed yet.
    Hold,
    /// QA has not seen this head: dispatch a testing task to this profile.
    Dispatch(Worker),
}

pub async fn testing_gate(
    pool: &SqlitePool,
    repo_id: Uuid,
    pr_number: i64,
    head_sha: &str,
) -> Result<TestingGate, sqlx::Error> {
    let Some(ws) = PullRequest::find_latest_workspace_for_pr(pool, repo_id, pr_number).await?
    else {
        return Ok(TestingGate::Proceed);
    };
    let Some(dev) = WorkerTask::find_by_workspace(pool, ws).await? else {
        return Ok(TestingGate::Proceed);
    };
    let Some(issue_number) = dev.issue_number else {
        return Ok(TestingGate::Proceed);
    };
    let Some(issue) = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number).await? else {
        return Ok(TestingGate::Proceed);
    };
    if !plan_template(issue.body.as_deref()).is_some_and(|t| t.testing) {
        return Ok(TestingGate::Proceed);
    }
    let Some(qa) = qa_profile(pool).await? else {
        warn!(
            pr_number,
            "Issue asks for Testing but there is no QA profile; skipping the phase"
        );
        return Ok(TestingGate::Proceed);
    };

    if let Some((_, status, head, verdict)) =
        WorkerTask::latest_qa_test_for_pr(pool, repo_id, pr_number).await?
    {
        if head.as_deref() == Some(head_sha) {
            let passed =
                status == worker_task::STATUS_DONE && verdict.as_deref() == Some(VERDICT_PASS);
            return Ok(if passed {
                TestingGate::Proceed
            } else {
                TestingGate::Hold
            });
        }
        if matches!(status.as_str(), "queued" | "in_progress") {
            return Ok(TestingGate::Hold);
        }
    }
    Ok(TestingGate::Dispatch(qa))
}

/// Queue the testing task of a PR head on the QA profile.
pub async fn queue_testing(
    pool: &SqlitePool,
    qa: &Worker,
    repo_id: Uuid,
    pr_number: i64,
    pr_title: &str,
    head_sha: &str,
) -> Result<WorkerTask, sqlx::Error> {
    let task = WorkerTask::append(
        pool,
        qa.id,
        &CreateWorkerTask {
            repo_id,
            title: format!("Testing PR #{pr_number}: {pr_title}"),
            prompt: test_prompt(pr_number, head_sha),
            issue_number: Some(pr_number),
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        },
    )
    .await?;
    WorkerTask::set_kind(pool, task.id, worker_task::KIND_QA_TEST).await?;
    WorkerTask::set_qa_result(pool, task.id, Some(head_sha), None).await?;
    Ok(task)
}

/// Testing gate, called by `dispatch_review_task` for automatic dispatches.
/// `true` when the review may start; otherwise it makes sure a testing task
/// is running (or waiting for the fix) for `head_sha` and returns `false`.
pub async fn review_may_start(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    repo_id: Uuid,
    pr_number: i64,
    pr_title: &str,
    head_sha: &str,
) -> Result<bool, sqlx::Error> {
    match testing_gate(&db.pool, repo_id, pr_number, head_sha).await? {
        TestingGate::Proceed => Ok(true),
        TestingGate::Hold => Ok(false),
        TestingGate::Dispatch(qa) => {
            queue_testing(&db.pool, &qa, repo_id, pr_number, pr_title, head_sha).await?;
            info!(
                pr_number,
                head_sha, "Testing phase dispatched before review"
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

/// Read and store the verdict of a testing task that just finished, before
/// its worktree is archived. Returns `(verdict, reasons)`.
pub async fn read_testing_verdict(
    pool: &SqlitePool,
    workspace_id: Uuid,
    task: &WorkerTask,
) -> Option<(String, String)> {
    let parsed = match worktree_path(pool, workspace_id).await {
        Some(path) => std::fs::read_to_string(path.join(QA_JSON_RELATIVE_PATH))
            .ok()
            .and_then(|raw| serde_json::from_str::<QaVerdict>(&raw).ok())
            .filter(|v| v.verdict == VERDICT_PASS || v.verdict == VERDICT_FAIL),
        None => None,
    };
    let (verdict, reasons) = match parsed {
        Some(v) => (v.verdict, v.reasons),
        None => (
            VERDICT_ERROR.to_string(),
            format!("El QA no dejó un veredicto válido en {QA_JSON_RELATIVE_PATH}."),
        ),
    };
    if let Err(e) = WorkerTask::set_qa_result(pool, task.id, None, Some(&verdict)).await {
        warn!(task_id = %task.id, "Failed to store QA verdict: {}", e);
    }
    if !reasons.trim().is_empty()
        && let Err(e) = WorkerTask::record_deliverable(pool, task.id, Some(&reasons), None).await
    {
        warn!(task_id = %task.id, "Failed to store QA reasons: {}", e);
    }
    Some((verdict, reasons))
}

/// After a testing task: pass → dispatch the review; fail → send the reasons
/// back to the developer.
pub async fn after_testing(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    task: &WorkerTask,
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
            let prompt = format!(
                "El QA probó el PR #{pr_number} y encontró problemas:\n\n{reasons}\n\n\
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
                    title: format!("Fix QA PR #{pr_number}"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_plan_block() {
        let body = "## Brief\n\nalgo\n\n<!-- fluke:plan {\"template\":\"tdd\"} -->\n";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                tdd: true,
                testing: true
            })
        );
        let body = "<!--fluke:plan {\"template\":\"no_tdd\"}-->";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                tdd: false,
                testing: true
            })
        );
        // Another fluke block before the plan one.
        let body = "<!-- fluke:decision {\"questions\":[]} -->\n<!-- fluke:plan {\"template\":\"tdd\"} -->";
        assert_eq!(
            plan_template(Some(body)),
            Some(PlanTemplate {
                tdd: true,
                testing: true
            })
        );
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
