//! Play por milestone (fluke v2, #666): the engine behind `milestone_runs`.
//!
//! On every sweep (the PR monitor tick, plus right after play) each active
//! run looks at the issues of its GitHub milestone, finds the lowest wave
//! with work left, and dispatches the issues of that wave that are ready:
//! no `pm:decision` label and no task. A wave is finished when all its issues
//! are closed (PR merged with "Closes #n") or their latest task is `done`.
//! Merging is always a human decision: the run only waits for it.
//!
//! `decide` is the pure part (tested below); `advance_run` applies it.

use std::{collections::HashMap, sync::Arc};

use db::{
    DBService,
    models::{
        milestone_run::{self, MilestoneRun},
        repo_issue::RepoIssue,
        worker::{self, Worker},
        worker_task::{self, CreateWorkerTask, WorkerTask},
    },
};
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::services::{
    config::Config, container::ContainerService, execution_labels, qa_phases, territory,
    worker_orchestrator,
};

pub const PM_DECISION_LABEL: &str = "pm:decision";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    None,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone)]
pub struct IssueInfo {
    pub number: i64,
    pub wave: i64,
    pub closed: bool,
    pub decision: bool,
    pub task: TaskState,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Every wave is finished.
    Done,
    /// A wave just finished and the run is in step mode.
    Paused { wave: i64 },
    /// Work on `wave`: dispatch `dispatch`; `waiting` explains why the run
    /// is stopped when nothing can move (`decision:<n>` / `failed:<n>`).
    Work {
        wave: i64,
        dispatch: Vec<i64>,
        waiting: Option<String>,
    },
}

/// What a run should do now, given its issues, the wave it was on and
/// whether it pauses between waves.
pub fn decide(issues: &[IssueInfo], previous_wave: Option<i64>, step_mode: bool) -> Step {
    let finished = |i: &IssueInfo| i.closed || i.task == TaskState::Done;
    let Some(wave) = issues.iter().filter(|i| !finished(i)).map(|i| i.wave).min() else {
        return Step::Done;
    };
    if step_mode && previous_wave.is_some_and(|p| wave > p) {
        return Step::Paused { wave };
    }

    let mut pending: Vec<&IssueInfo> = issues
        .iter()
        .filter(|i| i.wave == wave && !finished(i))
        .collect();
    pending.sort_by_key(|i| i.number);

    let dispatch: Vec<i64> = pending
        .iter()
        .filter(|i| !i.decision && i.task == TaskState::None)
        .map(|i| i.number)
        .collect();
    let active = pending.iter().any(|i| i.task == TaskState::Active);
    let blocker = pending
        .iter()
        .find(|i| i.decision && i.task != TaskState::Active)
        .map(|i| format!("decision:{}", i.number))
        .or_else(|| {
            pending
                .iter()
                .find(|i| i.task == TaskState::Failed)
                .map(|i| format!("failed:{}", i.number))
        });
    let waiting = if dispatch.is_empty() && !active {
        blocker
    } else {
        None
    };
    Step::Work {
        wave,
        dispatch,
        waiting,
    }
}

#[derive(Deserialize)]
struct LabelRow {
    name: String,
}

fn label_names(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<LabelRow>>(raw)
        .map(|v| v.into_iter().map(|l| l.name).collect())
        .unwrap_or_default()
}

/// Same text the UI's "Assign to agent" builds (assignToAgentPrompt.ts).
pub fn issue_prompt(number: i64, title: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).unwrap_or("");
    let body_section = if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n\n")
    };
    format!(
        "Resolvé el issue #{number}: {title}\n\n{body_section}Antes de empezar, corré `gh issue view {number} --comments` para leer la discusión completa. Cuando el trabajo esté listo, el PR debe incluir 'Closes #{number}' en su descripción."
    )
}

/// The developer profile a milestone run hands issues to (#680): profiles
/// run several tasks at once, so the first active developer is enough.
async fn pick_developer(pool: &SqlitePool) -> Result<Option<Uuid>, sqlx::Error> {
    Ok(Worker::list_all(pool)
        .await?
        .into_iter()
        .find(|w| w.role == worker::ROLE_DEVELOPER)
        .map(|w| w.id))
}

pub async fn load_issues(
    pool: &SqlitePool,
    repo_id: Uuid,
    milestone: &str,
) -> Result<(Vec<IssueInfo>, HashMap<i64, RepoIssue>), sqlx::Error> {
    let mut infos = Vec::new();
    let mut by_number = HashMap::new();
    for issue in RepoIssue::list_by_repo(pool, repo_id).await? {
        if issue.milestone.as_deref() != Some(milestone) {
            continue;
        }
        let labels = label_names(&issue.labels);
        let Some(wave) = labels.iter().find_map(|l| execution_labels::wave_number(l)) else {
            continue;
        };
        let latest = WorkerTask::find_latest_by_issue(pool, repo_id, issue.number).await?;
        let tests_first = match &latest {
            Some(t) => {
                WorkerTask::kind(pool, t.id).await?.as_deref() == Some(worker_task::KIND_QA_TDD)
            }
            None => false,
        };
        let task = match latest {
            None => TaskState::None,
            // QA's tests are in: the developer still has to be dispatched.
            Some(t) if tests_first && t.status == worker_task::STATUS_DONE => TaskState::None,
            Some(t) if t.status == worker_task::STATUS_DONE => TaskState::Done,
            Some(t) if t.status == worker_task::STATUS_FAILED => TaskState::Failed,
            Some(_) => TaskState::Active,
        };
        infos.push(IssueInfo {
            number: issue.number,
            wave,
            closed: issue.state != "open",
            decision: labels.iter().any(|l| l == PM_DECISION_LABEL),
            task,
        });
        by_number.insert(issue.number, issue);
    }
    Ok((infos, by_number))
}

/// Apply one step to one run.
pub async fn advance_run(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    run: &MilestoneRun,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let (issues, by_number) = load_issues(pool, run.repo_id, &run.milestone).await?;

    match decide(&issues, run.current_wave, run.step_mode) {
        Step::Done => {
            MilestoneRun::set_state(
                pool,
                run.id,
                milestone_run::STATUS_DONE,
                run.current_wave,
                None,
            )
            .await
        }
        Step::Paused { wave } => {
            MilestoneRun::set_state(pool, run.id, milestone_run::STATUS_PAUSED, Some(wave), None)
                .await
        }
        Step::Work {
            wave,
            dispatch,
            waiting,
        } => {
            let mut kicked = Vec::new();
            for number in dispatch {
                let Some(issue) = by_number.get(&number) else {
                    continue;
                };
                // Someone may have assigned it by hand since load_issues.
                if WorkerTask::find_active_by_issue(pool, run.repo_id, number)
                    .await?
                    .is_some()
                {
                    continue;
                }
                // Tests first (#687): QA writes the tests, then the developer
                // starts from the branch QA pushed.
                let mut start_ref = None;
                if qa_phases::plan_template(issue.body.as_deref()).is_some_and(|t| t.tdd)
                    && let Some(qa) = qa_phases::qa_profile(pool).await?
                {
                    match WorkerTask::latest_qa_tdd_for_issue(pool, run.repo_id, number).await? {
                        None => {
                            let task = WorkerTask::append(
                                pool,
                                qa.id,
                                &CreateWorkerTask {
                                    repo_id: run.repo_id,
                                    title: format!("Tests #{} {}", number, issue.title),
                                    prompt: qa_phases::tdd_prompt(
                                        number,
                                        &issue.title,
                                        issue.body.as_deref(),
                                    ),
                                    issue_number: Some(number),
                                    skills: Vec::new(),
                                    issue_labels: Vec::new(),
                                    source: worker_task::SOURCE_MILESTONE.to_string(),
                                    territory_globs: Vec::new(),
                                },
                            )
                            .await?;
                            WorkerTask::set_kind(pool, task.id, worker_task::KIND_QA_TDD).await?;
                            info!(milestone = %run.milestone, issue = number, "Milestone run dispatched tests first");
                            kicked.push(qa.id);
                            continue;
                        }
                        Some((_, _, pushed)) => start_ref = pushed,
                    }
                }
                let Some(worker_id) = pick_developer(pool).await? else {
                    warn!(milestone = %run.milestone, "Milestone run: no active developer to dispatch to");
                    break;
                };
                let prompt = issue_prompt(number, &issue.title, issue.body.as_deref());
                let dev_task = WorkerTask::append(
                    pool,
                    worker_id,
                    &CreateWorkerTask {
                        repo_id: run.repo_id,
                        title: format!("#{} {}", number, issue.title),
                        territory_globs: territory::parse_territory_globs(&prompt),
                        prompt,
                        issue_number: Some(number),
                        skills: Vec::new(),
                        issue_labels: Vec::new(),
                        source: worker_task::SOURCE_MILESTONE.to_string(),
                    },
                )
                .await?;
                if let Some(start_ref) = &start_ref {
                    WorkerTask::set_start_ref(pool, dev_task.id, start_ref).await?;
                }
                info!(milestone = %run.milestone, issue = number, %worker_id, "Milestone run dispatched issue");
                kicked.push(worker_id);
            }
            let status = if waiting.is_some() {
                milestone_run::STATUS_WAITING
            } else {
                milestone_run::STATUS_RUNNING
            };
            MilestoneRun::set_state(pool, run.id, status, Some(wave), waiting.as_deref()).await?;
            if !kicked.is_empty() {
                // Start what fits in the free global slots (#680).
                if let Err(e) =
                    worker_orchestrator::kickstart_stuck_worker_queues(config, db, container).await
                {
                    warn!(milestone = %run.milestone, "Milestone run: failed to start tasks: {}", e);
                }
            }
            Ok(())
        }
    }
}

/// Sweep every active run. Called from the PR monitor tick.
pub async fn advance_all(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
) -> Result<(), sqlx::Error> {
    for run in MilestoneRun::list_active(&db.pool).await? {
        if let Err(e) = advance_run(config, db, container, &run).await {
            warn!(milestone = %run.milestone, "Milestone run sweep failed: {}", e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(number: i64, wave: i64) -> IssueInfo {
        IssueInfo {
            number,
            wave,
            closed: false,
            decision: false,
            task: TaskState::None,
        }
    }

    #[test]
    fn dispatches_the_lowest_wave_with_work_left() {
        let issues = [issue(1, 0), issue(2, 0), issue(3, 1)];
        assert_eq!(
            decide(&issues, None, false),
            Step::Work {
                wave: 0,
                dispatch: vec![1, 2],
                waiting: None
            }
        );
    }

    #[test]
    fn moves_on_when_the_wave_is_merged() {
        let mut a = issue(1, 0);
        a.closed = true;
        let mut b = issue(2, 0);
        b.task = TaskState::Done;
        let issues = [a, b, issue(3, 1)];
        assert_eq!(
            decide(&issues, Some(0), false),
            Step::Work {
                wave: 1,
                dispatch: vec![3],
                waiting: None
            }
        );
    }

    #[test]
    fn pauses_between_waves_in_step_mode() {
        let mut a = issue(1, 0);
        a.closed = true;
        let issues = [a, issue(2, 1)];
        assert_eq!(decide(&issues, Some(0), true), Step::Paused { wave: 1 });
        // After play the stored wave is 1, so it works on it.
        assert_eq!(
            decide(&issues, Some(1), true),
            Step::Work {
                wave: 1,
                dispatch: vec![2],
                waiting: None
            }
        );
    }

    #[test]
    fn waits_on_a_decision_only_when_nothing_else_moves() {
        let mut gate = issue(1, 0);
        gate.decision = true;
        let mut running = issue(2, 0);
        running.task = TaskState::Active;
        assert_eq!(
            decide(&[gate.clone(), running], None, false),
            Step::Work {
                wave: 0,
                dispatch: vec![],
                waiting: None
            }
        );
        assert_eq!(
            decide(&[gate], None, false),
            Step::Work {
                wave: 0,
                dispatch: vec![],
                waiting: Some("decision:1".into())
            }
        );
    }

    #[test]
    fn a_failed_task_stops_the_run() {
        let mut failed = issue(4, 0);
        failed.task = TaskState::Failed;
        assert_eq!(
            decide(&[failed], None, false),
            Step::Work {
                wave: 0,
                dispatch: vec![],
                waiting: Some("failed:4".into())
            }
        );
    }

    #[test]
    fn done_when_everything_is_finished() {
        let mut a = issue(1, 0);
        a.closed = true;
        assert_eq!(decide(&[a], Some(0), false), Step::Done);
        assert_eq!(decide(&[], None, false), Step::Done);
    }

    #[test]
    fn prompt_matches_the_ui() {
        assert_eq!(
            issue_prompt(7, "T", None),
            "Resolvé el issue #7: T\n\nAntes de empezar, corré `gh issue view 7 --comments` para leer la discusión completa. Cuando el trabajo esté listo, el PR debe incluir 'Closes #7' en su descripción."
        );
        assert!(issue_prompt(7, "T", Some(" cuerpo ")).contains("T\n\ncuerpo\n\nAntes"));
    }
}
