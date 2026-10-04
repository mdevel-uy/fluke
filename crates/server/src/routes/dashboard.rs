//! Dashboard v2: what each repo is doing, what runs right now and what each
//! ticket cost.
//!
//! A ticket is an issue, not a worker task: with the phase plan (#686) one
//! issue spawns design, tests-first, development, QA, review and fix tasks.
//! Counting tasks would multiply every resolved issue, and the cost of a
//! ticket must add all of them up. Review, QA-test and review-fix tasks are
//! keyed by the PR number instead of the issue, so they are mapped back
//! through the PR's workspace.
//!
//! A developer task whose PR the reviewer approved (`approved`) is finished
//! work waiting for the human merge: it counts as completed on the date it
//! was approved (`approved_at`, kept when the PR merges) and its ticket shows
//! in the merge gate until the merge. If the approval goes away before the
//! merge (changes requested, failure) or the PR is closed unmerged, it stops
//! counting.

use std::collections::{HashMap, HashSet};

use axum::{
    Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::get,
};
use chrono::Utc;
use db::models::{
    milestone_run::{self, MilestoneRun},
    repo::Repo,
    repo_issue::RepoIssue,
    worker::{self, Worker},
    worker_task,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::{
    issue_phases::{self, IssueBlocker},
    milestone_runs::{self, TaskState},
    stuck_task_detector, worker_orchestrator,
};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const MAX_WINDOW_DAYS: i64 = 400;
const DEFAULT_WINDOW_DAYS: i64 = 30;

/// One row of `worker_tasks` with what the dashboard needs.
#[derive(Debug, Clone, FromRow)]
pub struct TaskLite {
    pub id: Uuid,
    pub worker_id: Uuid,
    pub repo_id: Uuid,
    pub issue_number: Option<i64>,
    pub kind: Option<String>,
    pub role: String,
    pub status: String,
    pub title: String,
    pub workspace_id: Option<Uuid>,
    pub created_at: String,
    pub completed_at: Option<String>,
    /// When the reviewer approved the task's PR; kept once it merges.
    pub approved_at: Option<String>,
    pub cost_usd_total: Option<f64>,
    pub hours_saved_override: Option<f64>,
    /// Title of the issue `issue_number` names (meaningless for PR-keyed rows).
    pub issue_title: Option<String>,
}

impl TaskLite {
    /// Review, review-fix and gate (testing, docs, quality, security) tasks
    /// carry the PR number.
    fn keyed_by_pr(&self) -> bool {
        self.role == worker::ROLE_REVIEWER || worker_task::is_pr_keyed_kind(self.kind.as_deref())
    }

    /// Approved is not live: the agents are done, only the merge is left.
    fn is_live(&self) -> bool {
        !matches!(
            self.status.as_str(),
            worker_task::STATUS_DONE | worker_task::STATUS_FAILED | worker_task::STATUS_APPROVED
        )
    }
}

/// A PR opened from a workspace.
#[derive(Debug, Clone, FromRow)]
pub struct PrLink {
    pub repo_id: Option<Uuid>,
    pub pr_number: i64,
    pub workspace_id: Option<Uuid>,
    /// `open | merged | closed`.
    pub pr_status: Option<String>,
}

/// An approved PR waiting for the human merge.
#[derive(Debug, Clone, Serialize, TS)]
pub struct MergeGate {
    #[ts(type = "number | null")]
    pub pr_number: Option<i64>,
    pub workspace_id: Option<Uuid>,
    /// When the reviewer approved it. SQLite datetime string (UTC).
    pub approved_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct Ticket {
    pub key: String,
    pub repo_id: Uuid,
    /// The issue, or the PR when the ticket is a review of a PR without one.
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub is_pr: bool,
    pub title: String,
    /// When the last task was completed (done, or approved and waiting for
    /// the merge: its approval date), once nothing of the ticket is live and
    /// its latest issue task is completed. SQLite datetime string (UTC).
    pub resolved_at: Option<String>,
    /// Sum over every task of the ticket, retries and failures included.
    pub cost_usd: f64,
    #[ts(type = "number")]
    pub tasks: i64,
    /// Override of the most recent completed task that has one.
    pub hours_override: Option<f64>,
    /// Task that takes a new override: the latest completed one.
    pub edit_task_id: Option<Uuid>,
    pub edit_worker_id: Option<Uuid>,
    /// Set while a resolved ticket's PR is approved and not merged yet.
    pub merge_gate: Option<MergeGate>,
}

/// (repo, PR number) → issue, through the workspace the PR was opened from.
pub fn issue_of_pr(tasks: &[TaskLite], prs: &[PrLink]) -> HashMap<(Uuid, i64), i64> {
    let issue_of_ws: HashMap<Uuid, (Uuid, i64)> = tasks
        .iter()
        .filter(|t| !t.keyed_by_pr())
        .filter_map(|t| Some((t.workspace_id?, (t.repo_id, t.issue_number?))))
        .collect();
    prs.iter()
        .filter_map(|p| {
            let (repo, issue) = *issue_of_ws.get(&p.workspace_id?)?;
            (p.repo_id.is_none_or(|r| r == repo)).then_some(((repo, p.pr_number), issue))
        })
        .collect()
}

/// Latest PR opened from each workspace.
fn pr_of_workspace(prs: &[PrLink]) -> HashMap<Uuid, &PrLink> {
    let mut map: HashMap<Uuid, &PrLink> = HashMap::new();
    for p in prs {
        let Some(ws) = p.workspace_id else { continue };
        match map.get(&ws) {
            Some(prev) if prev.pr_number >= p.pr_number => {}
            _ => {
                map.insert(ws, p);
            }
        }
    }
    map
}

/// When a task counts as completed, if it does. Done: its approval date when
/// it went through one (the merge does not move it), else its completion.
/// Approved: its approval date (created_at for legacy rows without one),
/// unless its PR was closed without merging.
fn completed_on(t: &TaskLite, pr: Option<&PrLink>) -> Option<String> {
    match t.status.as_str() {
        worker_task::STATUS_DONE => t.approved_at.clone().or_else(|| t.completed_at.clone()),
        worker_task::STATUS_APPROVED
            if pr.is_some_and(|p| p.pr_status.as_deref() == Some("closed")) =>
        {
            None
        }
        worker_task::STATUS_APPROVED => Some(
            t.approved_at
                .clone()
                .unwrap_or_else(|| t.created_at.clone()),
        ),
        _ => None,
    }
}

/// Group tasks into tickets. Pure: tested below.
pub fn group_tickets(tasks: &[TaskLite], prs: &[PrLink]) -> Vec<Ticket> {
    let issue_of_pr = issue_of_pr(tasks, prs);
    let pr_of_ws = pr_of_workspace(prs);
    let pr_of = |t: &TaskLite| {
        let p = *pr_of_ws.get(&t.workspace_id?)?;
        p.repo_id.is_none_or(|r| r == t.repo_id).then_some(p)
    };

    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&TaskLite>> = HashMap::new();
    for t in tasks {
        let key = match t.issue_number {
            None => format!("task:{}", t.id),
            Some(n) if t.keyed_by_pr() => match issue_of_pr.get(&(t.repo_id, n)) {
                Some(issue) => format!("{}:issue:{issue}", t.repo_id),
                None => format!("{}:pr:{n}", t.repo_id),
            },
            Some(n) => format!("{}:issue:{n}", t.repo_id),
        };
        groups
            .entry(key.clone())
            .or_insert_with(|| {
                order.push(key);
                Vec::new()
            })
            .push(t);
    }

    order
        .into_iter()
        .map(|key| {
            let rows = &groups[&key];
            let is_pr = key.contains(":pr:");
            let first = rows[0];
            let issue_number = key
                .rsplit(':')
                .next()
                .and_then(|n| n.parse::<i64>().ok())
                .filter(|_| !key.starts_with("task:"));
            let primary = rows.iter().find(|t| !t.keyed_by_pr());
            let title = primary
                .and_then(|t| t.issue_title.clone())
                .or_else(|| primary.map(|t| t.title.clone()))
                .unwrap_or_else(|| first.title.clone());
            let mut done: Vec<(&TaskLite, String)> = rows
                .iter()
                .filter_map(|&t| Some((t, completed_on(t, pr_of(t))?)))
                .collect();
            done.sort_by(|a, b| a.1.cmp(&b.1));
            // The issue's own latest task (developer, designer...) decides: a
            // done review does not resolve an issue whose developer failed or
            // lost its approval.
            let deciding = rows
                .iter()
                .rev()
                .find(|t| !t.keyed_by_pr())
                .or(rows.last())
                .copied();
            let resolved_at = if rows.iter().any(|t| t.is_live())
                || deciding.and_then(|t| completed_on(t, pr_of(t))).is_none()
            {
                None
            } else {
                done.last().map(|(_, at)| at.clone())
            };
            let merge_gate = resolved_at
                .as_ref()
                .and_then(|_| {
                    done.iter()
                        .rev()
                        .find(|(t, _)| t.status == worker_task::STATUS_APPROVED)
                })
                .map(|(t, at)| MergeGate {
                    pr_number: pr_of(*t).map(|p| p.pr_number),
                    workspace_id: t.workspace_id,
                    approved_at: at.clone(),
                });
            let hours_override = done.iter().rev().find_map(|(t, _)| t.hours_saved_override);
            Ticket {
                repo_id: first.repo_id,
                issue_number,
                is_pr,
                title,
                resolved_at,
                cost_usd: rows.iter().filter_map(|t| t.cost_usd_total).sum(),
                tasks: rows.len() as i64,
                hours_override,
                edit_task_id: done.last().map(|(t, _)| t.id),
                edit_worker_id: done.last().map(|(t, _)| t.worker_id),
                merge_gate,
                key,
            }
        })
        .collect()
}

async fn load_tasks(pool: &SqlitePool) -> Result<Vec<TaskLite>, sqlx::Error> {
    sqlx::query_as(
        "SELECT t.id, t.worker_id, t.repo_id, t.issue_number, t.kind, w.role, t.status,
                t.title, t.workspace_id, t.created_at, t.completed_at, t.approved_at,
                t.cost_usd_total,
                t.hours_saved_override, ri.title AS issue_title
           FROM worker_tasks t
           JOIN workers w ON w.id = t.worker_id
           LEFT JOIN repo_issues ri ON ri.repo_id = t.repo_id AND ri.number = t.issue_number
          ORDER BY t.created_at ASC",
    )
    .fetch_all(pool)
    .await
}

async fn load_prs(pool: &SqlitePool) -> Result<Vec<PrLink>, sqlx::Error> {
    sqlx::query_as(
        "SELECT repo_id, pr_number, workspace_id, pr_status
           FROM pull_requests WHERE workspace_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await
}

#[derive(Debug, Deserialize)]
pub struct TicketsQuery {
    pub days: Option<i64>,
}

#[derive(Debug, Serialize, TS)]
pub struct TicketsResponse {
    /// Tickets resolved inside the window, newest first.
    pub tickets: Vec<Ticket>,
}

/// Tickets resolved in the last `days` days. One extra day of slack so the
/// client can bucket by its local calendar.
async fn list_tickets(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<TicketsQuery>,
) -> Result<ResponseJson<ApiResponse<TicketsResponse>>, ApiError> {
    let days = query.days.unwrap_or(DEFAULT_WINDOW_DAYS);
    if !(1..=MAX_WINDOW_DAYS).contains(&days) {
        return Err(ApiError::BadRequest(format!(
            "days must be between 1 and {MAX_WINDOW_DAYS}"
        )));
    }
    let pool = &deployment.db().pool;
    let cutoff = (Utc::now() - chrono::Duration::days(days + 1))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let mut tickets: Vec<Ticket> = group_tickets(&load_tasks(pool).await?, &load_prs(pool).await?)
        .into_iter()
        .filter(|t| {
            t.resolved_at
                .as_deref()
                .is_some_and(|at| at >= cutoff.as_str())
        })
        .collect();
    tickets.sort_by(|a, b| b.resolved_at.cmp(&a.resolved_at));
    Ok(ResponseJson(ApiResponse::success(TicketsResponse {
        tickets,
    })))
}

/// One issue of the active milestone, for the wave map.
#[derive(Debug, Serialize, TS)]
pub struct WaveCell {
    #[ts(type = "number")]
    pub number: i64,
    /// `done | active | failed | decision | pending`.
    pub state: String,
}

#[derive(Debug, Serialize, TS)]
pub struct Wave {
    #[ts(type = "number")]
    pub wave: i64,
    pub cells: Vec<WaveCell>,
}

#[derive(Debug, Serialize, TS)]
pub struct RepoMilestone {
    pub name: String,
    /// `running | paused | waiting`.
    pub status: String,
    #[ts(type = "number | null")]
    pub current_wave: Option<i64>,
    pub waiting_reason: Option<String>,
    pub waves: Vec<Wave>,
    #[ts(type = "number")]
    pub issues_total: i64,
    #[ts(type = "number")]
    pub issues_closed: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, TS)]
pub struct RepoOverview {
    pub repo_id: Uuid,
    pub name: String,
    pub milestone: Option<RepoMilestone>,
    #[ts(type = "number")]
    pub running: i64,
    #[ts(type = "number")]
    pub blocked: i64,
    #[ts(type = "number")]
    pub open_prs: i64,
    /// Latest task start or finish. SQLite datetime string (UTC).
    pub last_activity: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct PhaseChip {
    /// `design | tdd | dev | test | review | merge`.
    pub kind: String,
    /// `pending | active | done | changes | stuck`.
    pub state: String,
}

/// A task an agent is working right now.
#[derive(Debug, Serialize, TS)]
pub struct RunningTask {
    pub task_id: Uuid,
    pub worker_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub repo_id: Uuid,
    pub repo_name: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub title: String,
    pub profile: String,
    pub role: String,
    /// Agent and model the profile runs on.
    pub executor: String,
    pub model: Option<String>,
    pub status: String,
    pub phases: Vec<PhaseChip>,
    #[ts(type = "number")]
    pub steps_done: i64,
    #[ts(type = "number")]
    pub steps_total: i64,
    /// Cost of the whole ticket so far.
    pub cost_usd: f64,
    /// When the agent started this run. SQLite datetime string (UTC).
    pub started_at: String,
}

#[derive(Debug, Serialize, TS)]
pub struct QueuedTask {
    pub task_id: Uuid,
    pub repo_name: String,
    #[ts(type = "number | null")]
    pub issue_number: Option<i64>,
    pub title: String,
    pub profile: String,
}

#[derive(Debug, Serialize, TS)]
pub struct DashboardBlocker {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[ts(type = "number")]
    pub issue_number: i64,
    pub issue_title: String,
    pub blocker: IssueBlocker,
}

#[derive(Debug, Serialize, TS)]
pub struct DashboardOverview {
    pub repos: Vec<RepoOverview>,
    pub running: Vec<RunningTask>,
    pub queued: Vec<QueuedTask>,
    pub blockers: Vec<DashboardBlocker>,
    /// Agents running now and the concurrency limit (0 = no limit).
    #[ts(type = "number")]
    pub slots_used: i64,
    #[ts(type = "number")]
    pub slots_limit: i64,
}

const PHASE_KINDS: [&str; 10] = [
    "design", "arch", "tdd", "dev", "docs", "test", "quality", "security", "review", "merge",
];

/// One chip per phase kind: the state of the latest phase of that kind.
fn phase_chips(phases: &[issue_phases::IssuePhase]) -> Vec<PhaseChip> {
    PHASE_KINDS
        .iter()
        .filter_map(|kind| {
            let last = phases.iter().rev().find(|p| p.kind == *kind)?;
            Some(PhaseChip {
                kind: kind.to_string(),
                state: last.state.clone(),
            })
        })
        .collect()
}

fn wave_cell(issue: &milestone_runs::IssueInfo) -> &'static str {
    match issue.task {
        _ if issue.closed => "done",
        TaskState::Done => "done",
        TaskState::Active => "active",
        TaskState::Failed => "failed",
        TaskState::None if issue.decision => "decision",
        TaskState::None => "pending",
    }
}

async fn get_overview(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<DashboardOverview>>, ApiError> {
    let pool = &deployment.db().pool;
    let (max_rounds, slots_limit, default_executor) = {
        let config = deployment.config().read().await;
        (
            worker_orchestrator::resolve_max_review_rounds(&config),
            config.agent_concurrency_limit as i64,
            config.executor_profile.executor.to_string(),
        )
    };
    let stuck_minutes = stuck_task_detector::threshold_minutes();

    let tasks = load_tasks(pool).await?;
    let prs = load_prs(pool).await?;
    let tickets = group_tickets(&tasks, &prs);
    let ticket_cost: HashMap<(Uuid, i64), f64> = tickets
        .iter()
        .filter(|t| !t.is_pr)
        .filter_map(|t| Some(((t.repo_id, t.issue_number?), t.cost_usd)))
        .collect();
    let workers: HashMap<Uuid, Worker> = Worker::list_all(pool)
        .await?
        .into_iter()
        .map(|w| (w.id, w))
        .collect();
    let repos = Repo::list_all(pool).await?;
    let repo_name: HashMap<Uuid, String> = repos
        .iter()
        .map(|r| (r.id, r.display_name.clone()))
        .collect();
    let name_of = |id: &Uuid| repo_name.get(id).cloned().unwrap_or_default();

    // Blockers, across repos.
    let mut blockers = Vec::new();
    let mut issue_titles: HashMap<(Uuid, i64), String> = HashMap::new();
    for repo in &repos {
        for entry in issue_phases::list_blockers(pool, repo.id, max_rounds, stuck_minutes).await? {
            let title = RepoIssue::find_by_repo_and_number(pool, repo.id, entry.issue_number)
                .await?
                .map(|i| i.title)
                .unwrap_or_default();
            issue_titles.insert((repo.id, entry.issue_number), title.clone());
            blockers.push(DashboardBlocker {
                repo_id: repo.id,
                repo_name: repo.display_name.clone(),
                issue_number: entry.issue_number,
                issue_title: title,
                blocker: entry.blocker,
            });
        }
    }

    // Running tasks.
    let pr_issue = issue_of_pr(&tasks, &prs);
    let mut running = Vec::new();
    for t in tasks.iter().filter(|t| {
        matches!(
            t.status.as_str(),
            worker_task::STATUS_IN_PROGRESS | worker_task::STATUS_WAITING_USER
        )
    }) {
        let issue = match t.issue_number {
            Some(n) if t.keyed_by_pr() => pr_issue.get(&(t.repo_id, n)).copied(),
            n => n,
        };
        let phases = match issue {
            Some(n) => {
                let ri = RepoIssue::find_by_repo_and_number(pool, t.repo_id, n).await?;
                let plan = issue_phases::load_issue_plan(
                    pool,
                    t.repo_id,
                    n,
                    ri.as_ref().is_some_and(|i| i.state != "open"),
                    ri.as_ref().and_then(|i| i.body.as_deref()),
                    max_rounds,
                    stuck_minutes,
                )
                .await?;
                phase_chips(&plan.phases)
            }
            None => Vec::new(),
        };
        let (steps_done, steps_total): (i64, i64) = match t.workspace_id {
            Some(ws) => sqlx::query_as(
                "SELECT COALESCE(SUM(state = 'done'), 0), COUNT(*) FROM plan_steps WHERE workspace_id = ?1",
            )
            .bind(ws)
            .fetch_one(pool)
            .await?,
            None => (0, 0),
        };
        let started_at: Option<String> = match t.workspace_id {
            Some(ws) => {
                sqlx::query_scalar(
                    "SELECT MAX(ep.started_at) FROM execution_processes ep
                   JOIN sessions s ON s.id = ep.session_id
                  WHERE s.workspace_id = ?1 AND ep.run_reason = 'codingagent'",
                )
                .bind(ws)
                .fetch_one(pool)
                .await?
            }
            None => None,
        };
        let worker = workers.get(&t.worker_id);
        running.push(RunningTask {
            task_id: t.id,
            worker_id: t.worker_id,
            workspace_id: t.workspace_id,
            repo_id: t.repo_id,
            repo_name: name_of(&t.repo_id),
            issue_number: issue,
            title: issue
                .and_then(|n| issue_titles.get(&(t.repo_id, n)).cloned())
                .or_else(|| t.issue_title.clone().filter(|_| !t.keyed_by_pr()))
                .unwrap_or_else(|| t.title.clone()),
            profile: worker.map(|w| w.name.clone()).unwrap_or_default(),
            role: t.role.clone(),
            executor: worker
                .and_then(|w| w.executor.map(|e| e.to_string()))
                .unwrap_or_else(|| default_executor.clone()),
            model: worker.and_then(|w| w.model.clone()),
            status: t.status.clone(),
            phases,
            steps_done,
            steps_total,
            cost_usd: issue
                .and_then(|n| ticket_cost.get(&(t.repo_id, n)).copied())
                .unwrap_or_else(|| t.cost_usd_total.unwrap_or(0.0)),
            started_at: started_at.unwrap_or_else(|| t.created_at.clone()),
        });
    }

    let queued = tasks
        .iter()
        .filter(|t| t.status == worker_task::STATUS_QUEUED)
        .take(10)
        .map(|t| QueuedTask {
            task_id: t.id,
            repo_name: name_of(&t.repo_id),
            issue_number: t.issue_number,
            title: t.title.clone(),
            profile: workers
                .get(&t.worker_id)
                .map(|w| w.name.clone())
                .unwrap_or_default(),
        })
        .collect();

    // Repos.
    let open_prs: HashMap<Uuid, i64> = sqlx::query_as::<_, (Uuid, i64)>(
        "SELECT repo_id, COUNT(*) FROM pull_requests
          WHERE pr_status = 'open' AND repo_id IS NOT NULL GROUP BY repo_id",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let mut repo_rows = Vec::new();
    for repo in &repos {
        let mine: Vec<&TaskLite> = tasks.iter().filter(|t| t.repo_id == repo.id).collect();
        let last_activity = mine
            .iter()
            .map(|t| t.completed_at.as_ref().unwrap_or(&t.created_at))
            .max()
            .cloned();
        let run = MilestoneRun::list_by_repo(pool, repo.id)
            .await?
            .into_iter()
            .filter(|r| r.status != milestone_run::STATUS_DONE)
            .max_by_key(|r| r.updated_at);
        let milestone = match run {
            Some(run) => {
                let (infos, _) = milestone_runs::load_issues(pool, repo.id, &run.milestone).await?;
                let mut waves: Vec<Wave> = Vec::new();
                let mut sorted = infos.clone();
                sorted.sort_by_key(|i| (i.wave, i.number));
                for info in &sorted {
                    let cell = WaveCell {
                        number: info.number,
                        state: wave_cell(info).to_string(),
                    };
                    match waves.last_mut() {
                        Some(w) if w.wave == info.wave => w.cells.push(cell),
                        _ => waves.push(Wave {
                            wave: info.wave,
                            cells: vec![cell],
                        }),
                    }
                }
                let issues: Vec<RepoIssue> = RepoIssue::list_by_repo(pool, repo.id)
                    .await?
                    .into_iter()
                    .filter(|i| i.milestone.as_deref() == Some(run.milestone.as_str()))
                    .collect();
                let numbers: HashSet<i64> = issues.iter().map(|i| i.number).collect();
                Some(RepoMilestone {
                    name: run.milestone.clone(),
                    status: run.status.clone(),
                    current_wave: run.current_wave,
                    waiting_reason: run.waiting_reason.clone(),
                    waves,
                    issues_total: issues.len() as i64,
                    issues_closed: issues.iter().filter(|i| i.state != "open").count() as i64,
                    cost_usd: ticket_cost
                        .iter()
                        .filter(|((r, n), _)| *r == repo.id && numbers.contains(n))
                        .map(|(_, c)| c)
                        .sum(),
                })
            }
            None => None,
        };
        repo_rows.push(RepoOverview {
            repo_id: repo.id,
            name: repo.display_name.clone(),
            milestone,
            running: running.iter().filter(|r| r.repo_id == repo.id).count() as i64,
            blocked: blockers.iter().filter(|b| b.repo_id == repo.id).count() as i64,
            open_prs: open_prs.get(&repo.id).copied().unwrap_or(0),
            last_activity,
        });
    }
    // Busy repos first, then by recent activity.
    repo_rows.sort_by(|a, b| {
        let busy = |r: &RepoOverview| r.running + r.blocked + r.milestone.is_some() as i64;
        busy(b)
            .min(1)
            .cmp(&busy(a).min(1))
            .then_with(|| b.last_activity.cmp(&a.last_activity))
    });

    let slots_used: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM execution_processes WHERE status = 'running' AND run_reason = 'codingagent'",
    )
    .fetch_one(pool)
    .await?;

    Ok(ResponseJson(ApiResponse::success(DashboardOverview {
        repos: repo_rows,
        running,
        queued,
        blockers,
        slots_used,
        slots_limit,
    })))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/dashboard/tickets", get(list_tickets))
        .route("/dashboard/overview", get(get_overview))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(role: &str, kind: Option<&str>, issue: i64, status: &str, ws: u128) -> TaskLite {
        TaskLite {
            id: Uuid::new_v4(),
            worker_id: Uuid::nil(),
            repo_id: Uuid::nil(),
            issue_number: Some(issue),
            kind: kind.map(str::to_string),
            role: role.to_string(),
            status: status.to_string(),
            title: format!("task {issue}"),
            workspace_id: (ws != 0).then(|| Uuid::from_u128(ws)),
            created_at: "2026-10-01 10:00:00".into(),
            completed_at: (status == "done").then(|| "2026-10-02 10:00:00".into()),
            approved_at: (status == "approved").then(|| "2026-10-03 09:00:00".into()),
            cost_usd_total: Some(1.0),
            hours_saved_override: None,
            issue_title: Some(format!("Issue {issue}")),
        }
    }

    #[test]
    fn review_and_qa_tasks_join_their_issue_through_the_pr() {
        let tasks = vec![
            task("developer", None, 12, "done", 1),
            task("reviewer", None, 40, "done", 0),
            task("qa", Some("qa_test"), 40, "done", 0),
            task("developer", Some("review_fix"), 40, "done", 1),
            // A review of a PR nobody opened from an issue.
            task("reviewer", None, 41, "done", 0),
        ];
        let prs = vec![PrLink {
            repo_id: Some(Uuid::nil()),
            pr_number: 40,
            workspace_id: Some(Uuid::from_u128(1)),
            pr_status: Some("merged".into()),
        }];
        let tickets = group_tickets(&tasks, &prs);
        assert_eq!(tickets.len(), 2);
        assert_eq!(tickets[0].issue_number, Some(12));
        assert_eq!(tickets[0].tasks, 4);
        assert!((tickets[0].cost_usd - 4.0).abs() < 1e-9);
        assert_eq!(tickets[0].title, "Issue 12");
        assert!(tickets[1].is_pr);
    }

    #[test]
    fn a_ticket_with_live_work_is_not_resolved() {
        let tasks = vec![
            task("designer", Some("design_handoff"), 7, "done", 2),
            task("developer", None, 7, "in_progress", 3),
        ];
        let tickets = group_tickets(&tasks, &[]);
        assert_eq!(tickets.len(), 1);
        assert!(tickets[0].resolved_at.is_none());
    }

    const APPROVED_AT: &str = "2026-10-03 09:00:00";

    /// Issue 50: design, development (workspace 5, PR 60), review and QA.
    fn gate_case(dev: TaskLite, pr_status: &str) -> Vec<Ticket> {
        let tasks = vec![
            task("designer", Some("design_handoff"), 50, "done", 4),
            dev,
            task("reviewer", None, 60, "done", 0),
            task("qa", Some("qa_test"), 60, "done", 0),
        ];
        let prs = vec![PrLink {
            repo_id: Some(Uuid::nil()),
            pr_number: 60,
            workspace_id: Some(Uuid::from_u128(5)),
            pr_status: Some(pr_status.into()),
        }];
        group_tickets(&tasks, &prs)
    }

    #[test]
    fn an_approved_pr_without_merge_is_completed_and_waits_for_the_gate() {
        let tickets = gate_case(task("developer", None, 50, "approved", 5), "open");
        // Four tasks of one issue: one ticket, counted once.
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].tasks, 4);
        assert_eq!(tickets[0].resolved_at.as_deref(), Some(APPROVED_AT));
        let gate = tickets[0].merge_gate.as_ref().expect("waits for the merge");
        assert_eq!(gate.pr_number, Some(60));
        assert_eq!(gate.workspace_id, Some(Uuid::from_u128(5)));
        assert_eq!(gate.approved_at, APPROVED_AT);
    }

    #[test]
    fn the_merge_leaves_the_gate_and_keeps_the_approval_date() {
        let mut dev = task("developer", None, 50, "done", 5);
        dev.approved_at = Some(APPROVED_AT.into());
        dev.completed_at = Some("2026-10-05 12:00:00".into());
        let tickets = gate_case(dev, "merged");
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].resolved_at.as_deref(), Some(APPROVED_AT));
        assert!(tickets[0].merge_gate.is_none());
    }

    #[test]
    fn losing_the_approval_before_the_merge_stops_counting() {
        // Changes requested: back to review, the approval date is cleared.
        for status in ["in_review", "in_progress", "failed"] {
            let tickets = gate_case(task("developer", None, 50, status, 5), "open");
            assert_eq!(tickets.len(), 1);
            assert!(tickets[0].resolved_at.is_none(), "{status}");
            assert!(tickets[0].merge_gate.is_none(), "{status}");
        }
    }

    #[test]
    fn an_approved_pr_closed_without_merge_does_not_count() {
        let tickets = gate_case(task("developer", None, 50, "approved", 5), "closed");
        assert!(tickets[0].resolved_at.is_none());
        assert!(tickets[0].merge_gate.is_none());
    }

    #[test]
    fn an_approved_task_without_approval_date_uses_its_creation() {
        let mut dev = task("developer", None, 50, "approved", 5);
        dev.approved_at = None;
        dev.created_at = "2026-10-02 08:00:00".into();
        let tickets = gate_case(dev, "open");
        // The review finished later: the ticket resolves then.
        assert_eq!(
            tickets[0].resolved_at.as_deref(),
            Some("2026-10-02 10:00:00")
        );
        assert!(tickets[0].merge_gate.is_some());
    }
}
