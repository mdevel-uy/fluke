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
use futures_util::{StreamExt, TryStreamExt};
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
        .route("/fluke-events/stream", get(fluke_events_stream))
}

#[derive(Deserialize)]
struct FlukeEventsStreamQuery {
    /// Resume after this id; without it, only events from now on.
    after: Option<i64>,
}

/// Domain events as they happen (J6.1): one SSE `fluke` event per row of
/// `fluke_events`, pushed when SQLite writes it. The UI updates itself from
/// here instead of polling. Each wake-up reads the committed rows after the
/// last one sent, so nothing is skipped if a signal is lost.
async fn fluke_events_stream(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<FlukeEventsStreamQuery>,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>>,
    ApiError,
> {
    let pool = deployment.db().pool.clone();
    let start = match q.after {
        Some(after) => after,
        None => FlukeEvent::last_id(&pool).await?,
    };
    let wake = services::services::events::fluke_events_bus().subscribe();
    let stream = futures_util::stream::unfold(
        (pool, wake, start),
        |(pool, mut wake, cursor)| async move {
            // The hook fires before the commit: give it a moment.
            let woke = wake.recv().await;
            if matches!(woke, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let rows = FlukeEvent::list_after(&pool, cursor, 500)
                .await
                .unwrap_or_default();
            let next = rows.last().map(|e| e.id).unwrap_or(cursor);
            let events: Vec<Result<Event, std::convert::Infallible>> = rows
                .iter()
                .filter_map(|e| Event::default().event("fluke").json_data(e).ok())
                .map(Ok)
                .collect();
            Some((futures_util::stream::iter(events), (pool, wake, next)))
        },
    )
    .flatten();
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
