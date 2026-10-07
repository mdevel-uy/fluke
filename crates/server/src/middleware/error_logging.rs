use axum::{
    extract::{MatchedPath, OriginalUri, Request},
    middleware::Next,
    response::Response,
};
use utils::app_errors::{self, REQUEST_ERRORS, REQUEST_EXECUTION_FAILURE};

pub async fn log_server_errors(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let uri = request
        .extensions()
        .get::<OriginalUri>()
        .map(|original| original.0.clone())
        .unwrap_or_else(|| request.uri().clone());
    let matched_path = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned());

    // Scope the whole future (not a thread local): concurrent requests cannot
    // accidentally merge their failures. Child tasks report independently.
    let (response, errors, execution_failure) = REQUEST_EXECUTION_FAILURE
        .scope(
            std::cell::Cell::new(false),
            REQUEST_ERRORS.scope(std::cell::RefCell::new(Vec::new()), async {
                let response = next.run(request).await;
                let errors = REQUEST_ERRORS.with(|errors| errors.take());
                let execution_failure = REQUEST_EXECUTION_FAILURE.with(|flag| flag.get());
                (response, errors, execution_failure)
            }),
        )
        .await;

    if response.status().is_server_error() {
        let path = matched_path.as_deref().unwrap_or("<unmatched>");
        // Exclude execution causes, not whole agent-related routes. A DB error
        // on /sessions or /workers is still an internal application failure.
        // Delivery retries must not become new errors of the reporter itself.
        let reporter = path.split('/').any(|segment| segment == "app-errors");
        let mut context = errors
            .first()
            .map(|e| e.error.context.clone())
            .unwrap_or_default();
        if errors.is_empty() {
            context.logs = app_errors::recent_logs();
        }
        for (index, error) in errors.iter().enumerate() {
            context
                .fields
                .insert(format!("underlying_{index}"), error.error.message.clone());
            context.fields.insert(
                format!("underlying_location_{index}"),
                error.error.location.clone(),
            );
        }
        // The cause distinguishes independent failures of the same endpoint;
        // the middleware log itself never introduces a second fingerprint.
        let detail = context
            .fields
            .get("error")
            .cloned()
            .or_else(|| errors.first().map(|e| e.error.message.clone()));
        let mut message = format!("API request returned server error: {} {}", method, path);
        if let Some(detail) = detail {
            message.push_str(": ");
            message.push_str(&detail);
        }
        context.fields.insert("method".into(), method.to_string());
        context.fields.insert("matched_path".into(), path.into());
        context
            .fields
            .insert("status".into(), response.status().as_u16().to_string());
        // Route-level follow-up logs can describe the same executor failure.
        // A typed, non-execution API cause (e.g. SQLx) is independently reportable.
        let internal_api_failure = errors
            .iter()
            .any(|e| e.error.context.fields.contains_key("error_type"));
        if (!execution_failure || internal_api_failure) && !reporter {
            app_errors::record(
                &message,
                &format!("{path} {}", response.status().as_u16()),
                "api",
                context,
            );
        }
        // Preserve the existing log for operators/Sentry without capturing a
        // second notification from this same request.
        tracing::error!(target: "app_errors::http_log",
            method = %method,
            uri = %uri,
            matched_path = matched_path.as_deref().unwrap_or("<unmatched>"),
            status = %response.status(),
            "API request returned server error"
        );
    } else {
        for error in errors {
            app_errors::flush_request_error(error);
        }
    }

    response
}

#[cfg(test)]
mod tests {
    use axum::{Router, http::StatusCode, routing::get};
    use executors::executors::ExecutorError;
    use tracing_subscriber::prelude::*;

    use super::*;
    use crate::error::ApiError;

    #[tokio::test(flavor = "current_thread")]
    async fn underlying_error_and_500_are_one_notice_and_workers_are_excluded() {
        let subscriber = tracing_subscriber::registry().with(app_errors::AppErrorLayer);
        let _guard = tracing::subscriber::set_default(subscriber);
        let app = Router::new()
            .route(
                "/test-app-error-dedup",
                get(|| async {
                    tracing::error!("Test underlying app failure");
                    StatusCode::INTERNAL_SERVER_ERROR
                }),
            )
            .route(
                "/test-worker-error",
                get(|| async {
                    tracing::error!(target: "executors::test", "Worker execution failed");
                    StatusCode::INTERNAL_SERVER_ERROR
                }),
            )
            .route(
                "/sessions",
                get(|| async { ApiError::Database(sqlx::Error::RowNotFound) }),
            )
            .route(
                "/sessions/executor-failure",
                get(|| async {
                    ApiError::Executor(ExecutorError::SpawnError(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "Agent executable missing",
                    )))
                }),
            )
            .route(
                "/sessions/repeated-error",
                get(|| async {
                    for _ in 0..120 {
                        tracing::error!("Repeated non-5xx handler failure");
                    }
                    StatusCode::OK
                }),
            )
            .layer(axum::middleware::from_fn(log_server_errors));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        for _ in 0..3 {
            assert_eq!(
                client
                    .get(format!("http://{addr}/test-app-error-dedup"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::INTERNAL_SERVER_ERROR
            );
        }
        client
            .get(format!("http://{addr}/test-worker-error"))
            .send()
            .await
            .unwrap();
        for (path, expected) in [
            ("/sessions", StatusCode::INTERNAL_SERVER_ERROR),
            (
                "/sessions/executor-failure",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            ("/sessions/repeated-error", StatusCode::OK),
        ] {
            assert_eq!(
                client
                    .get(format!("http://{addr}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        server.abort();
        let errors = app_errors::snapshot().1;
        let app: Vec<_> = errors
            .iter()
            .filter(|e| e.location == "/test-app-error-dedup 500")
            .collect();
        assert_eq!(app.len(), 1);
        assert_eq!(app[0].count, 3);
        assert_eq!(
            errors
                .iter()
                .filter(|e| e.location == "/sessions 500")
                .count(),
            1
        );
        assert!(
            !errors
                .iter()
                .any(|e| e.location == "/sessions/executor-failure 500")
        );
        assert_eq!(
            errors
                .iter()
                .find(|e| e.message == "Repeated non-5xx handler failure")
                .unwrap()
                .count,
            120
        );
        assert!(
            !errors
                .iter()
                .any(|e| e.message == "Test underlying app failure"
                    || e.location == "/test-worker-error 500")
        );
    }
}
