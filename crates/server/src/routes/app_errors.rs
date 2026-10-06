//! Separate session SSE, using the same authenticated local API transport as
//! Fluke events. Coalesces storms into at most one snapshot per second.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path},
    http::StatusCode,
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::stream;
use utils::app_errors::{self, ErrorContext, FrontendReport};

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/app-errors/report", post(report))
        .route("/app-errors/stream", get(events))
        .route("/app-errors/{fingerprint}/ignore", post(ignore))
        .layer(DefaultBodyLimit::max(32 * 1024))
}

async fn report(Json(report): Json<FrontendReport>) -> StatusCode {
    if report.source != "frontend"
        || report.message.trim().is_empty()
        || report.message.len() > 4096
        || report.location.as_ref().is_some_and(|v| v.len() > 4096)
        || report.stack.as_ref().is_some_and(|v| v.len() > 8192)
        || report
            .component_stack
            .as_ref()
            .is_some_and(|v| v.len() > 8192)
    {
        return StatusCode::BAD_REQUEST;
    }
    // B sends the first application stack frame as location. Remove machine
    // prefixes here as well so reports from different installations agree.
    let location = report
        .location
        .as_deref()
        .or_else(|| {
            report.stack.as_deref().and_then(|stack| {
                stack
                    .lines()
                    .find(|line| line.contains("/src/") || line.contains("/assets/"))
            })
        })
        .unwrap_or("frontend");
    let location = app_errors::normalized_location(location);
    app_errors::record(
        &report.message,
        &location,
        "frontend",
        ErrorContext {
            stack: report.stack,
            component_stack: report.component_stack,
            ..Default::default()
        },
    );
    StatusCode::NO_CONTENT
}

async fn ignore(Path(fingerprint): Path<String>) -> StatusCode {
    if fingerprint.len() != 15
        || !fingerprint.starts_with("fp-")
        || !fingerprint[3..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return StatusCode::BAD_REQUEST;
    }
    if app_errors::ignore(&fingerprint) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

async fn events() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>>
{
    static SESSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let session = SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string());
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let stream = stream::unfold(
        (interval, None),
        move |(mut interval, mut revision)| async move {
            loop {
                interval.tick().await;
                let (next, errors) = app_errors::snapshot();
                if revision == Some(next) {
                    continue;
                }
                revision = Some(next);
                // The UI only needs summaries. Analysis context stays server-side.
                if let Ok(event) = Event::default()
                    .event("app-errors")
                    .json_data(serde_json::json!({ "session_id": session, "errors": errors }))
                {
                    return Some((Ok(event), (interval, revision)));
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frontend_contract_validates_before_recording() {
        let body = serde_json::json!({
            "source": "frontend", "message": "Frontend contract test failure",
            "stack": "Error\n at http://localhost:3000/src/report-contract.ts:10:1",
            "location": null, "component_stack": null,
        });
        let valid: FrontendReport = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(report(Json(valid)).await, StatusCode::NO_CONTENT);
        let errors = app_errors::snapshot().1;
        assert!(
            errors
                .iter()
                .any(|e| e.source == "frontend" && e.location == "at src/report-contract.ts:10:1")
        );
        for message in [String::new(), "x".repeat(4097)] {
            let mut invalid: FrontendReport = serde_json::from_value(body.clone()).unwrap();
            invalid.message = message;
            assert_eq!(report(Json(invalid)).await, StatusCode::BAD_REQUEST);
        }
        let mut invalid: FrontendReport = serde_json::from_value(body).unwrap();
        invalid.source = "backend".into();
        assert_eq!(report(Json(invalid)).await, StatusCode::BAD_REQUEST);
        assert_eq!(
            ignore(Path("invalid".into())).await,
            StatusCode::BAD_REQUEST
        );
    }
}
