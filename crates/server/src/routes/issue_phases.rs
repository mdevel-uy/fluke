//! Plan de fases del issue (fluke v2, F3, #686): read-only view of an
//! issue's life cycle, derived by `services::issue_phases`.

use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    repo_issue::RepoIssue,
    worker_task::{self, CreateWorkerTask, WorkerTask},
    workspace::Workspace,
};
use deployment::Deployment;
use serde::Deserialize;
use services::services::{
    container::ContainerService,
    issue_phases::{self, IssueBlockerEntry, IssuePlanResponse},
    qa_phases, stuck_task_detector, worker_orchestrator,
};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/repos/{repo_id}/issues/{issue_number}/phases",
            get(get_issue_phases),
        )
        .route("/repos/{repo_id}/issues/blockers", get(get_issue_blockers))
        .route(
            "/repos/{repo_id}/issues/{issue_number}/unstick",
            post(unstick_issue),
        )
}

async fn get_issue_phases(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
) -> Result<ResponseJson<ApiResponse<IssuePlanResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let issue = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number).await?;
    let issue_closed = issue.as_ref().is_some_and(|i| i.state != "open");
    let plan = issue_phases::load_issue_plan(
        pool,
        repo_id,
        issue_number,
        issue_closed,
        issue.as_ref().and_then(|i| i.body.as_deref()),
        max_rounds(&deployment).await,
        stuck_task_detector::threshold_minutes(),
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(plan)))
}

async fn max_rounds(deployment: &DeploymentImpl) -> i64 {
    worker_orchestrator::resolve_max_review_rounds(&*deployment.config().read().await)
}

async fn get_issue_blockers(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<IssueBlockerEntry>>>, ApiError> {
    let list = issue_phases::list_blockers(
        &deployment.db().pool,
        repo_id,
        max_rounds(&deployment).await,
        stuck_task_detector::threshold_minutes(),
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(list)))
}

/// An exit of the Destrabar drawer (#696) other than answering the agent.
#[derive(Debug, Deserialize, TS)]
pub struct UnstickRequest {
    /// `retry`: the failed task goes back to the queue.
    /// `back_to_tests`: drop the open work and let QA redo the tests first.
    /// `cancel`: drop the open work (the client closes the issue).
    pub action: String,
    /// What the person adds for QA on `back_to_tests`.
    #[ts(optional)]
    pub note: Option<String>,
}

async fn unstick_issue(
    State(deployment): State<DeploymentImpl>,
    Path((repo_id, issue_number)): Path<(Uuid, i64)>,
    axum::Json(req): axum::Json<UnstickRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    let kick = match req.action.as_str() {
        "retry" => {
            let id: Uuid = sqlx::query_scalar(
                "SELECT t.id FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
                  WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND t.status = 'failed'
                    AND w.role <> 'reviewer'
                  ORDER BY t.created_at DESC LIMIT 1",
            )
            .bind(repo_id)
            .bind(issue_number)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| ApiError::Conflict("No hay una fase fallida para reintentar".into()))?;
            let task = WorkerTask::set_status(pool, id, worker_task::STATUS_QUEUED).await?;
            vec![task.worker_id]
        }
        "back_to_tests" => {
            let issue = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number)
                .await?
                .ok_or_else(|| ApiError::BadRequest("Issue not found".into()))?;
            let qa = qa_phases::qa_profile(pool)
                .await?
                .ok_or_else(|| ApiError::Conflict("No hay un perfil QA activo".into()))?;
            let mut kick = drop_open_tasks(&deployment, repo_id, issue_number).await?;
            let mut prompt =
                qa_phases::tdd_prompt(issue_number, &issue.title, issue.body.as_deref());
            if let Some(note) = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                prompt.push_str("\n\nThe developer got stuck on these tests. The user says:\n");
                prompt.push_str(note);
            }
            let task = WorkerTask::append(
                pool,
                qa.id,
                &CreateWorkerTask {
                    repo_id,
                    title: format!("Tests #{} {}", issue_number, issue.title),
                    prompt,
                    issue_number: Some(issue_number),
                    skills: Vec::new(),
                    issue_labels: Vec::new(),
                    source: worker_task::SOURCE_MILESTONE.to_string(),
                    territory_globs: Vec::new(),
                },
            )
            .await?;
            WorkerTask::set_kind(pool, task.id, worker_task::KIND_QA_TDD).await?;
            kick.push(qa.id);
            kick
        }
        "cancel" => drop_open_tasks(&deployment, repo_id, issue_number).await?,
        other => return Err(ApiError::BadRequest(format!("Unknown action: {other}"))),
    };

    // Offer the freed or retried slots their next task, as the task routes do.
    for worker_id in kick {
        let deployment = deployment.clone();
        tokio::spawn(async move {
            if let Err(e) = worker_orchestrator::try_take_next(
                deployment.config(),
                deployment.db(),
                deployment.container(),
                worker_id,
            )
            .await
                && !e.is_conflict()
            {
                tracing::warn!(worker_id = %worker_id, "Unstick: next task did not start: {e}");
            }
        });
    }
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Stops and deletes the issue's unfinished tasks (any profile but the
/// reviewer), like cancelling each one. Returns the workers to kick.
async fn drop_open_tasks(
    deployment: &DeploymentImpl,
    repo_id: Uuid,
    issue_number: i64,
) -> Result<Vec<Uuid>, ApiError> {
    let pool = &deployment.db().pool;
    let rows: Vec<(Uuid, Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT t.id, t.worker_id, t.workspace_id
           FROM worker_tasks t JOIN workers w ON w.id = t.worker_id
          WHERE t.repo_id = ?1 AND t.issue_number = ?2 AND w.role <> 'reviewer'
            AND t.status IN ('queued', 'in_progress', 'waiting_user', 'failed', 'in_review', 'approved')",
    )
    .bind(repo_id)
    .bind(issue_number)
    .fetch_all(pool)
    .await?;
    let mut workers = Vec::new();
    for (task_id, worker_id, workspace_id) in rows {
        if let Some(ws) = workspace_id
            && let Ok(Some(workspace)) = Workspace::find_by_id(pool, ws).await
        {
            deployment.container().try_stop(&workspace, false).await;
        }
        WorkerTask::delete(pool, task_id).await?;
        if !workers.contains(&worker_id) {
            workers.push(worker_id);
        }
    }
    Ok(workers)
}
