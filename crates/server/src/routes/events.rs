use axum::{
    BoxError, Router,
    extract::{Query, State},
    response::{
        Json as ResponseJson, Sse,
        sse::{Event, KeepAlive},
    },
    routing::get,
};
use db::models::fluke_event::FlukeEvent;
use deployment::Deployment;
use futures_util::TryStreamExt;
use serde::Deserialize;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

async fn events(
    State(deployment): State<DeploymentImpl>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, BoxError>>>, axum::http::StatusCode>
{
    // Ask the container service for a combined "history + live" stream
    let stream = deployment.stream_events().await;
    Ok(Sse::new(stream.map_err(|e| -> BoxError { e.into() })).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct FlukeEventsQuery {
    /// Only events after this id; without it, the latest ones.
    after: Option<i64>,
    limit: Option<i64>,
}

/// Domain events (task, review, PR/CI, mission, run, plan, profile): what
/// happened in the app, written by SQLite triggers. Poll with `after`.
async fn fluke_events(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<FlukeEventsQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<FlukeEvent>>>, ApiError> {
    let pool = &deployment.db().pool;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let events = match q.after {
        Some(after) => FlukeEvent::list_after(pool, after, limit).await?,
        None => FlukeEvent::latest(pool, limit).await?,
    };
    Ok(ResponseJson(ApiResponse::success(events)))
}

pub(super) fn router(_: &DeploymentImpl) -> Router<DeploymentImpl> {
    let events_router = Router::new().route("/", get(events));

    Router::new()
        .nest("/events", events_router)
        .route("/fluke-events", get(fluke_events))
}
