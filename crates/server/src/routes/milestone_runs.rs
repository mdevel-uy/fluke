//! Play por milestone (fluke v2, #666). Endpoints behind the Plan view's
//! play / pause / reset buttons, "Ejecutar todas" and "Pausar al terminar
//! cada wave". The engine is `services::milestone_runs`.

use axum::{
    Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::milestone_run::MilestoneRun;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::milestone_runs;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PlayMilestoneRequest {
    pub milestone: String,
    #[serde(default)]
    pub step_mode: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct MilestoneRequest {
    pub milestone: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PlayAllMilestonesRequest {
    pub milestones: Vec<String>,
    #[serde(default)]
    pub step_mode: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StepModeRequest {
    pub step_mode: bool,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/repos/{repo_id}/milestone-runs", get(list_runs))
        .route("/repos/{repo_id}/milestone-runs/play", post(play))
        .route("/repos/{repo_id}/milestone-runs/play-all", post(play_all))
        .route("/repos/{repo_id}/milestone-runs/pause", post(pause))
        .route("/repos/{repo_id}/milestone-runs/reset", post(reset))
        .route("/repos/{repo_id}/milestone-runs/step-mode", post(step_mode))
}

async fn list_runs(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<MilestoneRun>>>, ApiError> {
    let runs = MilestoneRun::list_by_repo(&deployment.db().pool, repo_id).await?;
    Ok(ResponseJson(ApiResponse::success(runs)))
}

/// Start or resume a run and take the first step right away, so the cards
/// move without waiting for the next monitor tick.
async fn start_run(
    deployment: &DeploymentImpl,
    repo_id: Uuid,
    milestone: &str,
    step_mode: bool,
) -> Result<MilestoneRun, ApiError> {
    let milestone = milestone.trim();
    if milestone.is_empty() {
        return Err(ApiError::BadRequest("milestone is required".into()));
    }
    let pool = &deployment.db().pool;
    deployment.repo().get_by_id(pool, repo_id).await?;
    let run = MilestoneRun::play(pool, repo_id, milestone, step_mode).await?;
    milestone_runs::advance_run(
        deployment.config(),
        deployment.db(),
        deployment.container(),
        &run,
    )
    .await?;
    Ok(MilestoneRun::find(pool, repo_id, milestone)
        .await?
        .unwrap_or(run))
}

async fn play(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<PlayMilestoneRequest>,
) -> Result<ResponseJson<ApiResponse<MilestoneRun>>, ApiError> {
    let run = start_run(&deployment, repo_id, &req.milestone, req.step_mode).await?;
    Ok(ResponseJson(ApiResponse::success(run)))
}

async fn play_all(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<PlayAllMilestonesRequest>,
) -> Result<ResponseJson<ApiResponse<Vec<MilestoneRun>>>, ApiError> {
    let mut runs = Vec::new();
    for milestone in &req.milestones {
        runs.push(start_run(&deployment, repo_id, milestone, req.step_mode).await?);
    }
    Ok(ResponseJson(ApiResponse::success(runs)))
}

async fn pause(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<MilestoneRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    MilestoneRun::pause(&deployment.db().pool, repo_id, &req.milestone).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

async fn reset(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<MilestoneRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    MilestoneRun::delete(&deployment.db().pool, repo_id, &req.milestone).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

async fn step_mode(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<StepModeRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    MilestoneRun::set_step_mode(&deployment.db().pool, repo_id, req.step_mode).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}
