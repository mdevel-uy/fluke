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

/// Template used until the QA phases exist (#687): Desarrollo → Review → Merge.
pub const TEMPLATE_NO_TDD: &str = "no_tdd";

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
    /// `origin | design | dev | review | merge`.
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
    for r in rounds {
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
            phase.state = match r.status.as_str() {
                "submitted" => "done",
                "failed" => "stuck",
                _ => "active",
            }
            .to_string();
            if phase.state == "done" && phase.finished_at.is_none() {
                phase.finished_at = Some(r.updated_at.clone());
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

pub async fn load_issue_plan(
    pool: &SqlitePool,
    repo_id: Uuid,
    issue_number: i64,
    issue_closed: bool,
) -> Result<IssuePlanResponse, sqlx::Error> {
    const TASK_COLUMNS: &str =
        "t.id, t.status, t.kind, t.workspace_id, t.created_at, t.completed_at,
            t.result_summary, t.failure_reason, t.cost_usd_total,
            w.name AS worker_name, w.role AS worker_role";
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
        let row: Option<(i64, String, String)> = sqlx::query_as(
            "SELECT pr_number, pr_url, pr_status FROM pull_requests
              WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(ws)
        .fetch_optional(pool)
        .await?;
        if let Some((number, url, status)) = row {
            pr = Some(PrInfo {
                number,
                url,
                merged: status == "merged",
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

    Ok(IssuePlanResponse {
        template: TEMPLATE_NO_TDD.to_string(),
        pr_url: pr.as_ref().map(|p| p.url.clone()),
        pr_number: pr.as_ref().map(|p| p.number),
        phases,
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
    fn waiting_for_the_user_reads_as_stuck() {
        let t = task(ROLE_DEVELOPER, None, "waiting_user");
        assert_eq!(
            kinds(&build_phases(&[t], &[], &[], None, false))[1],
            s("dev", 1, "stuck")
        );
    }
}
