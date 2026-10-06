//! Finite snapshots work through direct HTTP, relay response signing and
//! WebRTC (both remote transports buffer the complete response body).
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path},
    http::StatusCode,
    routing::{get, post},
};
use utils::app_errors::{self, ErrorContext, FrontendReport};

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/app-errors/report", post(report))
        .route("/app-errors", get(snapshot))
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

async fn snapshot() -> Json<serde_json::Value> {
    static SESSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let session = SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string());
    let (_, errors) = app_errors::snapshot();
    let mut notices = Vec::with_capacity(errors.len());
    for error in errors {
        let lookup = services::services::app_error_issues::lookup(&error.fingerprint).await;
        let mut notice = serde_json::to_value(error).expect("serializable error summary");
        notice["lookup"] = serde_json::to_value(lookup).expect("serializable lookup");
        notices.push(notice);
    }
    // Analysis context stays server-side; the response always ends, allowing
    // relay signing and WebRTC to serialize it before delivering it to the UI.
    Json(serde_json::json!({ "session_id": session, "errors": notices }))
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, response::IntoResponse};

    use super::*;

    #[tokio::test]
    async fn snapshots_end_for_whole_body_transports_and_include_updates() {
        let message = "Finite snapshot transport test";
        let location = "server finite-snapshot-test.rs:1";
        let fingerprint = app_errors::fingerprint(message, location);
        app_errors::record(message, location, "backend", ErrorContext::default());
        let mut session = None;
        for count in 1..=2 {
            // Same complete-body operation required by relay response signing
            // and WebRTC. An infinite SSE would time out instead of delivering.
            let response = snapshot().await.into_response();
            let bytes = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                to_bytes(response.into_body(), 1024 * 1024),
            )
            .await
            .unwrap()
            .unwrap();
            let snapshot: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let current = snapshot["session_id"].as_str().unwrap().to_owned();
            if let Some(session) = &session {
                assert_eq!(session, &current);
            }
            session = Some(current);
            let error = snapshot["errors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["fingerprint"] == fingerprint)
                .unwrap();
            assert_eq!(error["count"], count);
            assert!(error.get("context").is_none());
            if count == 1 {
                app_errors::record(message, location, "backend", ErrorContext::default());
            }
        }
    }

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
