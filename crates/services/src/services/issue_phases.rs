//! Plan de fases del issue (fluke v2, F3, #686).
//!
//! The life cycle of an issue already exists implicitly: a developer task
//! opens a PR, the reviewer submits rounds (`review_rounds`), request_changes
//! triggers a remediation in the author's branch, and a human merges. This
//! module turns those records into an ordered list of phases for the issue
//! page. It only reads: nothing here changes how issues are worked.
//!
//! `build_phases` is the pure part (tested below); `load_issue_plan` fetches
//! the rows.

use db::models::worker::{ROLE_DESIGNER, ROLE_DEVELOPER};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::services::qa_phases::{self, PlanTemplate};

/// Phase templates (#687). `none`: the issue has no `fluke:plan` block and
/// keeps today's flow (Desarrollo → Review → Merge).
pub const TEMPLATE_TDD: &str = "tdd";
pub const TEMPLATE_NO_TDD: &str = "no_tdd";
pub const TEMPLATE_NONE: &str = "none";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssuePhaseStep {
    #[ts(type = "number")]
    pub n: i64,
    pub title: String,
    /// `pending | active | done | cut`.
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssuePhase {
    /// `origin | design | tdd | dev | test | review | merge`.
    pub kind: String,
    /// 1-based round for `dev` and `review`; 1 for the rest.
    #[ts(type = "number")]
    pub round: i64,
    /// `pending | active | done | changes | stuck`.
    pub state: String,
    /// Profile that ran (or runs) the phase.
    pub profile: Option<String>,
    pub role: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub cost_usd: Option<f64>,
    /// Task summary, review reasons or failure reason.
    pub output: Option<String>,
    /// The developer's own plan for this phase (plan MCP steps).
    pub steps: Vec<IssuePhaseStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssuePlanResponse {
    pub template: String,
    pub pr_url: Option<String>,
    #[ts(type = "number | null")]
    pub pr_number: Option<i64>,
    pub phases: Vec<IssuePhase>,
    /// Why the issue needs a person right now, if it does (#694).
    pub blocker: Option<IssueBlocker>,
}

/// Why an issue needs a person (fluke v2, F4, #694). Derived on read from
/// tasks, review rounds and running processes; nothing is stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssueBlocker {
    /// `question | credential | failed | review_cap | conflict | no_progress`.
    pub kind: String,
    /// Phase that is stuck, as `<kind>-<round>`.
    pub phase: Option<String>,
    /// The agent's question, the failure reason or what happened.
    pub message: String,
    /// The agent's question as sent to ask_user (JSON), for `question`.
    pub question: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub task_id: Option<Uuid>,
    pub since: Option<String>,
}

/// An issue of the repo that needs a person, for the Plan view (#694).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssueBlockerEntry {
    #[ts(type = "number")]
    pub issue_number: i64,
    pub blocker: IssueBlocker,
}

fn blocker_at(kind: &str, phase: &IssuePhase, message: String) -> IssueBlocker {
    IssueBlocker {
        kind: kind.to_string(),
        phase: Some(format!("{}-{}", phase.kind, phase.round)),
        message,
        question: None,
        workspace_id: phase.workspace_id,
        task_id: phase.task_id,
        since: phase
            .finished_at
            .clone()
            .or_else(|| phase.started_at.clone()),
    }
}

/// The issue's blocker, checked in order of what the person can act on
/// first: a question, a missing credential, a failure, the review rounds
/// ran out, the PR conflicts with its base, the agent running for too long. `tasks` are every task behind
/// the phases; `running_since` is when the agent of the last active phase
/// started, if it has been running past the threshold. Marks the phase it
/// points at as stuck.
pub fn pick_blocker(
    phases: &mut [IssuePhase],
    tasks: &[&TaskRow],
    pr: Option<&PrInfo>,
    rounds: &[RoundRow],
    max_rounds: i64,
    running_since: Option<String>,
    stuck_minutes: i64,
) -> Option<IssueBlocker> {
    let task_of = |p: &IssuePhase| p.task_id.and_then(|id| tasks.iter().find(|t| t.id == id));

    // 1. The agent asked something.
    if let Some(i) = phases.iter().rposition(|p| {
        task_of(p).is_some_and(|t| t.status == "waiting_user" && t.pending_question.is_some())
    }) {
        let raw = task_of(&phases[i])?.pending_question.clone()?;
        let text = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("question")?.as_str().map(str::to_string))
            .unwrap_or_else(|| raw.clone());
        let mut b = blocker_at("question", &phases[i], text);
        b.question = Some(raw);
        // Tasks keep no "asked at"; the task start would read as a wrong age.
        b.since = None;
        phases[i].state = "stuck".to_string();
        return Some(b);
    }
    // 2. The agent's provider has no login on this machine.
    if let Some(i) = phases.iter().rposition(|p| {
        task_of(p).is_some_and(|t| {
            t.status == "failed"
                && t.failure_kind.as_deref() == Some(db::models::worker_task::FAILURE_KIND_PROVIDER)
        })
    }) {
        let msg = phases[i].output.clone().unwrap_or_default();
        return Some(blocker_at("credential", &phases[i], msg));
    }
    // 3. A phase failed: task failed, testing without verdict, round failed.
    if let Some(i) = phases.iter().rposition(|p| p.state == "stuck") {
        let msg = phases[i].output.clone().unwrap_or_default();
        return Some(blocker_at("failed", &phases[i], msg));
    }
    // 4. The review rounds ran out and the reviewer still asks for changes.
    if let Some(pr) = pr.filter(|p| !p.merged) {
        let submitted: Vec<&RoundRow> = rounds
            .iter()
            .filter(|r| r.kind == "review" && r.status == "submitted")
            .collect();
        if submitted.len() as i64 >= max_rounds
            && submitted.last().and_then(|r| r.verdict.as_deref()) == Some("request_changes")
            && let Some(i) = phases
                .iter()
                .rposition(|p| p.kind == "review" && p.state != "pending")
        {
            let msg = format!(
                "El PR #{} agotó las {max_rounds} rondas de review automáticas y el reviewer sigue pidiendo cambios.",
                pr.number
            );
            phases[i].state = "stuck".to_string();
            return Some(blocker_at("review_cap", &phases[i], msg));
        }
    }
    // 5. The PR conflicts with its base and nobody is fixing it (the server
    // already tried a clean merge when it turned conflicting).
    if let Some(pr) = pr.filter(|p| !p.merged)
        && let Some(ws) = pr.conflict_ws
        && let Some(i) = phases.iter().rposition(|p| p.kind == "merge")
    {
        let msg = format!(
            "El PR #{} tiene conflictos con la rama base y el merge automático no pudo resolverlos.",
            pr.number
        );
        phases[i].state = "stuck".to_string();
        let mut b = blocker_at("conflict", &phases[i], msg);
        b.workspace_id = Some(ws);
        return Some(b);
    }
    // 6. The agent has been running past the threshold.
    if let Some(since) = running_since
        && let Some(i) = last_running(phases)
    {
        let msg = format!("El agente lleva más de {stuck_minutes} minutos corriendo sin terminar.");
        phases[i].state = "stuck".to_string();
        let mut b = blocker_at("no_progress", &phases[i], msg);
        b.since = Some(since);
        return Some(b);
    }
    None
}

/// The last active phase with an agent behind it.
fn last_running(phases: &[IssuePhase]) -> Option<usize> {
    phases
        .iter()
        .rposition(|p| p.state == "active" && p.workspace_id.is_some())
}

/// Whether any process is running in the workspace.
async fn agent_running(pool: &SqlitePool, workspace_id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM execution_processes ep
           JOIN sessions s ON s.id = ep.session_id
          WHERE s.workspace_id = ?1 AND ep.status = 'running')",
    )
    .bind(workspace_id)
    .fetch_one(pool)
    .await
}

/// When the coding agent of `workspace_id` started, if it is still running
/// and started before `stuck_minutes` ago.
async fn running_since(
    pool: &SqlitePool,
    workspace_id: Uuid,
    stuck_minutes: i64,
) -> Result<Option<String>, sqlx::Error> {
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(stuck_minutes);
    sqlx::query_scalar(
        "SELECT MIN(ep.started_at) FROM execution_processes ep
           JOIN sessions s ON s.id = ep.session_id
          WHERE s.workspace_id = ?1 AND ep.status = 'running'
            AND ep.run_reason = 'codingagent' AND ep.started_at < ?2",
    )
    .bind(workspace_id)
    .bind(cutoff)
    .fetch_one(pool)
    .await
}

/// Open issues of the repo that need a person right now (#694). Candidates
/// are issues with a developer, designer or QA task that is still alive or
/// failed; each one is checked through its plan.
pub async fn list_blockers(
    pool: &SqlitePool,
    repo_id: Uuid,
    max_rounds: i64,
    stuck_minutes: i64,
) -> Result<Vec<IssueBlockerEntry>, sqlx::Error> {
    let candidates: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT t.issue_number
           FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
          WHERE t.repo_id = ?1 AND t.issue_number IS NOT NULL
            AND w.role <> 'reviewer' AND (t.kind IS NULL OR t.kind <> 'qa_test')
            AND t.status IN ('in_progress', 'waiting_user', 'failed', 'in_review', 'approved')",
    )
    .bind(repo_id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::new();
    for n in candidates {
        let Some(issue) =
            db::models::repo_issue::RepoIssue::find_by_repo_and_number(pool, repo_id, n).await?
        else {
            continue;
        };
        if issue.state != "open" {
            continue;
        }
        let plan = load_issue_plan(
            pool,
            repo_id,
            n,
            false,
            issue.body.as_deref(),
            max_rounds,
            stuck_minutes,
        )
        .await?;
        if let Some(blocker) = plan.blocker {
            out.push(IssueBlockerEntry {
                issue_number: n,
                blocker,
            });
        }
    }
    Ok(out)
}

/// A worker task of the issue, with its profile.
#[derive(Debug, Clone, FromRow)]
pub struct TaskRow {
    pub id: Uuid,
    pub status: String,
    pub kind: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub result_summary: Option<String>,
    pub failure_reason: Option<String>,
    pub cost_usd_total: Option<f64>,
    pub worker_name: String,
    pub worker_role: String,
    /// QA verdict of a testing task (`pass | fail | error`).
    pub qa_verdict: Option<String>,
    /// What the agent asked through ask_user, while waiting for the user.
    pub pending_question: Option<String>,
    pub failure_kind: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct RoundRow {
    pub kind: String,
    pub status: String,
    pub verdict: Option<String>,
    pub reasons: Option<String>,
    pub task_id: Option<Uuid>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct PrInfo {
    pub number: i64,
    pub url: String,
    pub merged: bool,
    /// Workspace of the PR while GitHub reports it conflicting with its base
    /// and no agent is working there.
    pub conflict_ws: Option<Uuid>,
}

fn task_state(status: &str) -> &'static str {
    match status {
        "queued" => "pending",
        "in_progress" => "active",
        "waiting_user" | "failed" => "stuck",
        _ => "done",
    }
}

fn phase_from_task(kind: &str, round: i64, t: &TaskRow) -> IssuePhase {
    IssuePhase {
        kind: kind.to_string(),
        round,
        state: task_state(&t.status).to_string(),
        profile: Some(t.worker_name.clone()),
        role: Some(t.worker_role.clone()),
        workspace_id: t.workspace_id,
        task_id: Some(t.id),
        started_at: Some(t.created_at.clone()),
        finished_at: t.completed_at.clone(),
        cost_usd: t.cost_usd_total,
        output: t
            .failure_reason
            .clone()
            .filter(|_| t.status == "failed")
            .or_else(|| t.result_summary.clone()),
        steps: Vec::new(),
    }
}

fn pending(kind: &str, round: i64) -> IssuePhase {
    IssuePhase {
        kind: kind.to_string(),
        round,
        state: "pending".to_string(),
        profile: None,
        role: None,
        workspace_id: None,
        task_id: None,
        started_at: None,
        finished_at: None,
        cost_usd: None,
        output: None,
        steps: Vec::new(),
    }
}

/// Ordered phases of an issue. `tasks` are the issue's tasks (any profile),
/// `rounds` the non-superseded review rounds of its PR, `reviewers` the
/// tasks those rounds point at.
pub fn build_phases(
    tasks: &[TaskRow],
    rounds: &[RoundRow],
    reviewers: &[TaskRow],
    pr: Option<&PrInfo>,
    issue_closed: bool,
) -> Vec<IssuePhase> {
    let mut phases = vec![IssuePhase {
        state: "done".to_string(),
        ..pending("origin", 1)
    }];

    for t in tasks.iter().filter(|t| t.worker_role == ROLE_DESIGNER) {
        phases.push(phase_from_task("design", 1, t));
    }

    let dev_tasks: Vec<&TaskRow> = tasks
        .iter()
        .filter(|t| t.worker_role == ROLE_DEVELOPER)
        .collect();
    let first_dev = dev_tasks
        .iter()
        .find(|t| t.kind.as_deref() != Some("review_fix"));
    let mut fixes = dev_tasks
        .iter()
        .filter(|t| t.kind.as_deref() == Some("review_fix"));

    let mut dev_round = 1;
    match first_dev {
        Some(t) => phases.push(phase_from_task("dev", dev_round, t)),
        None => phases.push(pending("dev", dev_round)),
    }

    let mut review_round = 0;
    let mut last_verdict: Option<&str> = None;
    for (i, r) in rounds.iter().enumerate() {
        if r.kind == "review" {
            review_round += 1;
            let reviewer = r
                .task_id
                .and_then(|id| reviewers.iter().find(|t| t.id == id));
            let mut phase = match reviewer {
                Some(t) => phase_from_task("review", review_round, t),
                None => pending("review", review_round),
            };
            phase.state = match (r.status.as_str(), r.verdict.as_deref()) {
                (_, Some("approve")) => "done",
                (_, Some("request_changes")) => "changes",
                ("failed", _) => "stuck",
                _ => "active",
            }
            .to_string();
            phase.output = r.reasons.clone().or(phase.output);
            if phase.started_at.is_none() {
                phase.started_at = Some(r.created_at.clone());
            }
            last_verdict = r.verdict.as_deref();
            phases.push(phase);
        } else if r.kind == "remediation" {
            // The fix runs in the author's branch: either as a follow-up of
            // the original task (no row of its own) or as a review_fix task.
            dev_round += 1;
            let mut phase = match fixes.next() {
                Some(t) => phase_from_task("dev", dev_round, t),
                None => {
                    let mut p = pending("dev", dev_round);
                    if let Some(first) = first_dev {
                        p.profile = Some(first.worker_name.clone());
                        p.role = Some(first.worker_role.clone());
                        p.workspace_id = first.workspace_id;
                    }
                    p.started_at = Some(r.created_at.clone());
                    p
                }
            };
            // The remediation row is only the dispatch claim and stays
            // pending: a later round means the fix already ran.
            let next = rounds.get(i + 1);
            phase.state = match r.status.as_str() {
                "submitted" => "done",
                "failed" => "stuck",
                _ if next.is_some() => "done",
                _ => "active",
            }
            .to_string();
            if phase.state == "done" && phase.finished_at.is_none() {
                phase.finished_at =
                    Some(next.map_or(&r.updated_at, |n| &n.created_at).clone());
            }
            phases.push(phase);
        }
    }

    // A round asked for changes and the fix has not started yet.
    if last_verdict == Some("request_changes")
        && !matches!(phases.last(), Some(p) if p.kind == "dev")
    {
        phases.push(pending("dev", dev_round + 1));
    }
    // Next review still to come.
    if last_verdict != Some("approve") && !matches!(phases.last(), Some(p) if p.kind == "review") {
        phases.push(pending("review", review_round + 1));
    }
    let merged = issue_closed || pr.is_some_and(|p| p.merged);
    phases.push(IssuePhase {
        state: if merged { "done" } else { "pending" }.to_string(),
        ..pending("merge", 1)
    });
    phases
}

/// Insert the QA phases (#687): tests first right before development, and
/// every testing run before the review that followed it. When the plan asks
/// for testing and the next review is still pending, a pending testing phase
/// goes in front of it.
pub fn add_qa_phases(
    mut phases: Vec<IssuePhase>,
    template: Option<PlanTemplate>,
    tdd: Option<&TaskRow>,
    tests: &[TaskRow],
) -> Vec<IssuePhase> {
    let tdd_phase = match tdd {
        Some(t) => Some(phase_from_task("tdd", 1, t)),
        None if template.is_some_and(|t| t.tdd) => Some(pending("tdd", 1)),
        None => None,
    };
    if let Some(p) = tdd_phase {
        let at = phases.iter().position(|q| q.kind == "dev").unwrap_or(1);
        phases.insert(at, p);
    }

    for (i, t) in tests.iter().enumerate() {
        let mut p = phase_from_task("test", i as i64 + 1, t);
        if t.status == "done" {
            p.state = match t.qa_verdict.as_deref() {
                Some(qa_phases::VERDICT_PASS) => "done",
                Some(qa_phases::VERDICT_FAIL) => "changes",
                _ => "stuck",
            }
            .to_string();
        }
        let at = phases
            .iter()
            .position(|q| {
                q.kind == "review"
                    && q.started_at
                        .as_deref()
                        .is_some_and(|s| s >= t.created_at.as_str())
            })
            .or_else(|| {
                phases
                    .iter()
                    .position(|q| q.kind == "review" && q.state == "pending")
            })
            .unwrap_or(phases.len() - 1);
        phases.insert(at, p);
    }

    if template.is_some_and(|t| t.testing)
        && let Some(at) = phases
            .iter()
            .position(|q| q.kind == "review" && q.state == "pending")
        && (at == 0 || phases[at - 1].kind != "test")
    {
        phases.insert(at, pending("test", tests.len() as i64 + 1));
    }
    phases
}

pub async fn load_issue_plan(
    pool: &SqlitePool,
    repo_id: Uuid,
    issue_number: i64,
    issue_closed: bool,
    issue_body: Option<&str>,
    max_rounds: i64,
    stuck_minutes: i64,
) -> Result<IssuePlanResponse, sqlx::Error> {
    const TASK_COLUMNS: &str =
        "t.id, t.status, t.kind, t.workspace_id, t.created_at, t.completed_at,
            t.result_summary, t.failure_reason, t.cost_usd_total,
            w.name AS worker_name, w.role AS worker_role, t.qa_verdict,
            t.pending_question, t.failure_kind";
    let tasks: Vec<TaskRow> = sqlx::query_as(&format!(
        "SELECT {TASK_COLUMNS}
           FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
          WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND w.role <> 'reviewer'
          ORDER BY t.created_at ASC"
    ))
    .bind(repo_id)
    .bind(issue_number)
    .fetch_all(pool)
    .await?;

    // The issue's PR: the latest one opened from one of its developer tasks.
    let mut pr: Option<PrInfo> = None;
    for t in tasks.iter().rev() {
        let Some(ws) = t.workspace_id else { continue };
        let row: Option<(i64, String, String, Option<String>)> = sqlx::query_as(
            "SELECT pr_number, pr_url, pr_status, pr_mergeable FROM pull_requests
              WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(ws)
        .fetch_optional(pool)
        .await?;
        if let Some((number, url, status, mergeable)) = row {
            let conflicting = status == "open" && mergeable.as_deref() == Some("conflicting");
            let busy = conflicting && agent_running(pool, ws).await?;
            pr = Some(PrInfo {
                number,
                url,
                merged: status == "merged",
                conflict_ws: (conflicting && !busy).then_some(ws),
            });
            break;
        }
    }

    let rounds: Vec<RoundRow> = match &pr {
        Some(p) => {
            sqlx::query_as(
                "SELECT kind, status, verdict, reasons, task_id, created_at, updated_at
                   FROM review_rounds
                  WHERE repo_id = ?1 AND pr_number = ?2 AND status <> 'superseded'
                  ORDER BY created_at ASC",
            )
            .bind(repo_id)
            .bind(p.number)
            .fetch_all(pool)
            .await?
        }
        None => Vec::new(),
    };

    let mut reviewers = Vec::new();
    for id in rounds.iter().filter_map(|r| r.task_id) {
        let row: Option<TaskRow> = sqlx::query_as(&format!(
            "SELECT {TASK_COLUMNS}
               FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
              WHERE t.id = ?1"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await?;
        reviewers.extend(row);
    }

    let mut phases = build_phases(&tasks, &rounds, &reviewers, pr.as_ref(), issue_closed);

    let template = qa_phases::plan_template(issue_body);
    let tdd = tasks
        .iter()
        .rev()
        .find(|t| t.kind.as_deref() == Some(db::models::worker_task::KIND_QA_TDD));
    let qa_tests: Vec<TaskRow> = match &pr {
        Some(p) => {
            sqlx::query_as(&format!(
                "SELECT {TASK_COLUMNS}
                   FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
                  WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND t.kind = 'qa_test'
                  ORDER BY t.created_at ASC"
            ))
            .bind(repo_id)
            .bind(p.number)
            .fetch_all(pool)
            .await?
        }
        None => Vec::new(),
    };
    phases = add_qa_phases(phases, template, tdd, &qa_tests);

    // The developer's own plan (plan MCP) for each dev phase. A follow-up fix
    // shares the original workspace, so only the latest dev phase of a
    // workspace gets its steps.
    let mut seen = Vec::new();
    for phase in phases.iter_mut().rev() {
        let Some(ws) = phase.workspace_id else {
            continue;
        };
        if phase.kind != "dev" || seen.contains(&ws) {
            continue;
        }
        seen.push(ws);
        phase.steps = sqlx::query_as::<_, (i64, String, String)>(
            "SELECT n, title, state FROM plan_steps WHERE workspace_id = ?1 ORDER BY n",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(n, title, state)| IssuePhaseStep { n, title, state })
        .collect();
    }

    let blocker = if issue_closed {
        None
    } else {
        let since = match last_running(&phases).and_then(|i| phases[i].workspace_id) {
            Some(ws) => running_since(pool, ws, stuck_minutes).await?,
            None => None,
        };
        let all: Vec<&TaskRow> = tasks.iter().chain(&reviewers).chain(&qa_tests).collect();
        pick_blocker(
            &mut phases,
            &all,
            pr.as_ref(),
            &rounds,
            max_rounds,
            since,
            stuck_minutes,
        )
    };

    Ok(IssuePlanResponse {
        template: match template {
            Some(t) if t.tdd => TEMPLATE_TDD,
            Some(_) => TEMPLATE_NO_TDD,
            None => TEMPLATE_NONE,
        }
        .to_string(),
        pr_url: pr.as_ref().map(|p| p.url.clone()),
        pr_number: pr.as_ref().map(|p| p.number),
        phases,
        blocker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(role: &str, kind: Option<&str>, status: &str) -> TaskRow {
        TaskRow {
            id: Uuid::new_v4(),
            status: status.to_string(),
            kind: kind.map(str::to_string),
            workspace_id: Some(Uuid::new_v4()),
            created_at: "2026-10-01 10:00:00".to_string(),
            completed_at: None,
            result_summary: None,
            failure_reason: None,
            cost_usd_total: None,
            worker_name: "Fullstack".to_string(),
            worker_role: role.to_string(),
            qa_verdict: None,
            pending_question: None,
            failure_kind: None,
        }
    }

    fn round(kind: &str, status: &str, verdict: Option<&str>, task_id: Option<Uuid>) -> RoundRow {
        RoundRow {
            kind: kind.to_string(),
            status: status.to_string(),
            verdict: verdict.map(str::to_string),
            reasons: verdict.map(|_| "motivos".to_string()),
            task_id,
            created_at: "2026-10-01 11:00:00".to_string(),
            updated_at: "2026-10-01 12:00:00".to_string(),
        }
    }

    fn kinds(phases: &[IssuePhase]) -> Vec<(String, i64, String)> {
        phases
            .iter()
            .map(|p| (p.kind.clone(), p.round, p.state.clone()))
            .collect()
    }

    fn s(k: &str, r: i64, st: &str) -> (String, i64, String) {
        (k.to_string(), r, st.to_string())
    }

    #[test]
    fn issue_without_tasks_shows_the_template_pending() {
        assert_eq!(
            kinds(&build_phases(&[], &[], &[], None, false)),
            vec![
                s("origin", 1, "done"),
                s("dev", 1, "pending"),
                s("review", 1, "pending"),
                s("merge", 1, "pending")
            ]
        );
    }

    #[test]
    fn running_developer_is_the_active_phase() {
        let t = task(ROLE_DEVELOPER, None, "in_progress");
        assert_eq!(
            kinds(&build_phases(&[t], &[], &[], None, false))[1],
            s("dev", 1, "active")
        );
    }

    #[test]
    fn a_review_with_changes_adds_the_fix_round() {
        let dev = task(ROLE_DEVELOPER, None, "in_review");
        let reviewer = task("reviewer", None, "done");
        let rounds = vec![
            round(
                "review",
                "submitted",
                Some("request_changes"),
                Some(reviewer.id),
            ),
            round("remediation", "pending", None, None),
        ];
        assert_eq!(
            kinds(&build_phases(&[dev], &rounds, &[reviewer], None, false)),
            vec![
                s("origin", 1, "done"),
                s("dev", 1, "done"),
                s("review", 1, "changes"),
                s("dev", 2, "active"),
                s("review", 2, "pending"),
                s("merge", 1, "pending"),
            ]
        );
    }

    #[test]
    fn a_fix_followed_by_a_new_review_is_done() {
        let dev = task(ROLE_DEVELOPER, None, "in_review");
        let rounds = vec![
            round("review", "submitted", Some("request_changes"), None),
            round("remediation", "pending", None, None),
            round("review", "submitted", Some("approve"), None),
        ];
        assert_eq!(
            kinds(&build_phases(&[dev], &rounds, &[], None, false))[3..].to_vec(),
            vec![
                s("dev", 2, "done"),
                s("review", 2, "done"),
                s("merge", 1, "pending")
            ]
        );
    }

    #[test]
    fn changes_requested_before_the_fix_starts() {
        let dev = task(ROLE_DEVELOPER, None, "in_review");
        let rounds = vec![round("review", "submitted", Some("request_changes"), None)];
        assert_eq!(
            kinds(&build_phases(&[dev], &rounds, &[], None, false))[3..].to_vec(),
            vec![
                s("dev", 2, "pending"),
                s("review", 2, "pending"),
                s("merge", 1, "pending")
            ]
        );
    }

    #[test]
    fn approved_and_merged() {
        let dev = task(ROLE_DEVELOPER, None, "done");
        let rounds = vec![round("review", "submitted", Some("approve"), None)];
        let pr = PrInfo {
            number: 1,
            url: "u".into(),
            merged: true,
            conflict_ws: None,
        };
        assert_eq!(
            kinds(&build_phases(&[dev], &rounds, &[], Some(&pr), true)),
            vec![
                s("origin", 1, "done"),
                s("dev", 1, "done"),
                s("review", 1, "done"),
                s("merge", 1, "done")
            ]
        );
    }

    #[test]
    fn qa_phases_wrap_development() {
        let mut dev = task(ROLE_DEVELOPER, None, "in_review");
        dev.created_at = "2026-10-01 10:00:00".into();
        let mut tdd = task("qa", Some("qa_tdd"), "done");
        tdd.created_at = "2026-10-01 09:00:00".into();
        let mut test = task("qa", Some("qa_test"), "done");
        test.created_at = "2026-10-01 10:30:00".into();
        test.qa_verdict = Some("pass".into());
        let rounds = vec![round("review", "pending", None, None)];
        let base = build_phases(&[tdd.clone(), dev], &rounds, &[], None, false);
        let template = Some(PlanTemplate {
            tdd: true,
            testing: true,
        });
        let phases = add_qa_phases(base, template, Some(&tdd), &[test]);
        assert_eq!(
            kinds(&phases),
            vec![
                s("origin", 1, "done"),
                s("tdd", 1, "done"),
                s("dev", 1, "done"),
                s("test", 1, "done"),
                s("review", 1, "active"),
                s("merge", 1, "pending"),
            ]
        );
    }

    #[test]
    fn a_plan_with_testing_shows_it_pending_before_review() {
        let dev = task(ROLE_DEVELOPER, None, "in_progress");
        let base = build_phases(&[dev], &[], &[], None, false);
        let phases = add_qa_phases(
            base,
            Some(PlanTemplate {
                tdd: false,
                testing: true,
            }),
            None,
            &[],
        );
        assert_eq!(
            kinds(&phases)[2..].to_vec(),
            vec![
                s("test", 1, "pending"),
                s("review", 1, "pending"),
                s("merge", 1, "pending")
            ]
        );
    }

    #[test]
    fn waiting_for_the_user_reads_as_stuck() {
        let t = task(ROLE_DEVELOPER, None, "waiting_user");
        assert_eq!(
            kinds(&build_phases(&[t], &[], &[], None, false))[1],
            s("dev", 1, "stuck")
        );
    }
    fn blocker_of(
        tasks: &[TaskRow],
        rounds: &[RoundRow],
        reviewers: &[TaskRow],
        pr: Option<&PrInfo>,
        running: Option<&str>,
    ) -> (Option<IssueBlocker>, Vec<IssuePhase>) {
        let mut phases = build_phases(tasks, rounds, reviewers, pr, false);
        let all: Vec<&TaskRow> = tasks.iter().chain(reviewers).collect();
        let b = pick_blocker(
            &mut phases,
            &all,
            pr,
            rounds,
            3,
            running.map(str::to_string),
            30,
        );
        (b, phases)
    }

    fn open_pr() -> PrInfo {
        PrInfo {
            number: 7,
            url: "u".into(),
            merged: false,
            conflict_ws: None,
        }
    }

    #[test]
    fn no_blocker_while_things_move() {
        let t = task(ROLE_DEVELOPER, None, "in_progress");
        assert!(blocker_of(&[t], &[], &[], None, None).0.is_none());
    }

    #[test]
    fn blocker_question() {
        let mut t = task(ROLE_DEVELOPER, None, "waiting_user");
        t.pending_question = Some(r#"{"question":"¿Postgres o SQLite?","options":[]}"#.into());
        let (b, _) = blocker_of(&[t.clone()], &[], &[], None, None);
        let b = b.unwrap();
        assert_eq!(b.kind, "question");
        assert_eq!(b.message, "¿Postgres o SQLite?");
        assert_eq!(b.phase.as_deref(), Some("dev-1"));
        assert_eq!(b.task_id, Some(t.id));
        assert!(b.question.is_some());
    }

    #[test]
    fn blocker_credential() {
        let mut t = task(ROLE_DEVELOPER, None, "failed");
        t.failure_kind = Some(db::models::worker_task::FAILURE_KIND_PROVIDER.into());
        t.failure_reason = Some("Claude no tiene sesión".into());
        let b = blocker_of(&[t], &[], &[], None, None).0.unwrap();
        assert_eq!(
            (b.kind.as_str(), b.message.as_str()),
            ("credential", "Claude no tiene sesión")
        );
    }

    #[test]
    fn blocker_failed() {
        let mut t = task(ROLE_DEVELOPER, None, "failed");
        t.failure_reason = Some("exit 1".into());
        let b = blocker_of(&[t], &[], &[], None, None).0.unwrap();
        assert_eq!((b.kind.as_str(), b.message.as_str()), ("failed", "exit 1"));
    }

    #[test]
    fn blocker_conflict() {
        let dev = task(ROLE_DEVELOPER, None, "approved");
        let rounds = vec![round("review", "submitted", Some("approve"), None)];
        let ws = Uuid::new_v4();
        let pr = PrInfo {
            conflict_ws: Some(ws),
            ..open_pr()
        };
        let (b, phases) = blocker_of(&[dev.clone()], &rounds, &[], Some(&pr), None);
        let b = b.unwrap();
        assert_eq!((b.kind.as_str(), b.workspace_id), ("conflict", Some(ws)));
        assert_eq!(phases.last().unwrap().state, "stuck");
        // Mergeable, or an agent already on it: not blocked.
        assert!(
            blocker_of(&[dev], &rounds, &[], Some(&open_pr()), None)
                .0
                .is_none()
        );
    }

    #[test]
    fn blocker_review_cap() {
        let dev = task(ROLE_DEVELOPER, None, "in_review");
        let changes = || round("review", "submitted", Some("request_changes"), None);
        let fix = || round("remediation", "submitted", None, None);
        let rounds = vec![changes(), fix(), changes(), fix(), changes()];
        let pr = open_pr();
        let (b, phases) = blocker_of(&[dev.clone()], &rounds, &[], Some(&pr), None);
        assert_eq!(b.unwrap().kind, "review_cap");
        assert!(
            phases
                .iter()
                .any(|p| p.kind == "review" && p.round == 3 && p.state == "stuck")
        );
        // Rounds left: not blocked.
        assert!(
            blocker_of(&[dev], &rounds[..3], &[], Some(&pr), None)
                .0
                .is_none()
        );
    }

    #[test]
    fn blocker_no_progress() {
        let t = task(ROLE_DEVELOPER, None, "in_progress");
        let (b, phases) = blocker_of(&[t], &[], &[], None, Some("2026-10-01 09:00:00"));
        let b = b.unwrap();
        assert_eq!(b.kind, "no_progress");
        assert_eq!(b.since.as_deref(), Some("2026-10-01 09:00:00"));
        assert_eq!(phases[1].state, "stuck");
    }

    #[test]
    fn a_question_wins_over_a_failure() {
        let mut failed = task(ROLE_DESIGNER, None, "failed");
        failed.failure_reason = Some("x".into());
        let mut asking = task(ROLE_DEVELOPER, None, "waiting_user");
        asking.pending_question = Some("texto plano".into());
        let b = blocker_of(&[failed, asking], &[], &[], None, None)
            .0
            .unwrap();
        assert_eq!(
            (b.kind.as_str(), b.message.as_str()),
            ("question", "texto plano")
        );
    }
}
