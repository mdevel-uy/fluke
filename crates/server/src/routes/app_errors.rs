//! Finite snapshots work through direct HTTP, relay response signing and
//! WebRTC (both remote transports buffer the complete response body).
use std::future::Future;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use utils::{
    app_errors::{self, AppErrorSummary, ErrorContext, FrontendReport, ReportedIssue},
    command_ext::NoWindowExt,
    shell::resolve_executable_path,
};

use crate::DeploymentImpl;

/// Repository that receives issues created from app errors.
const BUG_REPORT_REPO: &str = "mdevel-uy/fluke";
const MAX_TITLE_CHARS: usize = 100;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/app-errors/report", post(report))
        .route("/app-errors", get(snapshot))
        .route("/app-errors/{fingerprint}/ignore", post(ignore))
        .route("/app-errors/{fingerprint}/report-bug", post(report_bug))
        .layer(DefaultBodyLimit::max(32 * 1024))
}

fn valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 15
        && fingerprint.starts_with("fp-")
        && fingerprint[3..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportBugRequest {
    /// UI route where the notice was visible when the user reported it.
    screen: String,
}

fn iso(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| millis.to_string())
}

/// Single-line title derived from the first line of the message.
fn issue_title(message: &str) -> String {
    let first = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = line.chars().take(MAX_TITLE_CHARS).collect();
    if line.chars().count() > MAX_TITLE_CHARS {
        title.push('\u{2026}');
    }
    format!("App error: {title}")
}

/// Fence longer than any backtick run inside `text`, so it cannot be closed early.
fn fenced(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}\n{text}\n{fence}")
}

fn issue_body(error: &AppErrorSummary, screen: &str) -> String {
    let screen = screen.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "Reported from the app error notice.\n\n\
         ## Message\n\n{message}\n\n\
         ## When\n\n\
         - First seen: {first} (UTC)\n\
         - Last seen: {last} (UTC)\n\
         - Occurrences: {count}\n\n\
         ## Where\n\n\
         - Screen: `{screen}` (UI route open when the notice was reported; the error may have happened on an earlier screen)\n\
         - Source: `{source}`\n\
         - Location: `{location}`\n\n\
         ## Environment\n\n\
         - App version: {version}\n\
         - OS: {os}\n\n\
         Fingerprint: {fingerprint}\n",
        message = fenced(&error.message),
        first = iso(error.first_seen),
        last = iso(error.last_seen),
        count = error.count,
        source = error.source,
        location = error.location.replace('`', "'"),
        screen = screen.replace('`', "'"),
        version = utils::version::APP_VERSION,
        os = std::env::consts::OS,
        fingerprint = error.fingerprint,
    )
}

/// Human-readable reason for a failed `gh` call; never includes a stack or token.
fn gh_failure_reason(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let reason = if lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("http 401")
        || lower.contains("bad credentials")
    {
        "GitHub session missing or expired. Sign in to GitHub in Settings."
    } else if lower.contains("http 403") || lower.contains("forbidden") {
        "GitHub denied access to the repository."
    } else if lower.contains("http 404") || lower.contains("not found") {
        "The repository was not found or you do not have access to it."
    } else if lower.contains("http 422") {
        "GitHub rejected the issue."
    } else if lower.contains("http 429") || lower.contains("rate limit") {
        "GitHub rate limit reached. Try again in a few minutes."
    } else if lower.contains("dial tcp")
        || lower.contains("could not resolve")
        || lower.contains("timeout")
        || lower.contains("network")
        || lower.contains("connection")
    {
        "Could not reach GitHub. Check your connection."
    } else {
        let line: String = stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("unknown error")
            .chars()
            .take(200)
            .collect();
        return format!("GitHub CLI failed: {line}");
    };
    reason.to_owned()
}

/// Run `gh api repos/.../issues` with the JSON payload on stdin; returns stdout.
async fn run_gh_create(payload: Vec<u8>) -> Result<String, String> {
    use std::process::Stdio;

    use tokio::{io::AsyncWriteExt, process::Command};

    let gh = resolve_executable_path("gh")
        .await
        .ok_or_else(|| "The GitHub CLI (gh) is not installed.".to_owned())?;
    let mut cmd = Command::new(gh);
    cmd.args([
        "api",
        &format!("repos/{BUG_REPORT_REPO}/issues"),
        "--method",
        "POST",
        "--input",
        "-",
    ]);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.no_window();
    let mut child = cmd
        .spawn()
        .map_err(|_| "The GitHub CLI (gh) could not be started.".to_owned())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&payload)
            .await
            .map_err(|_| "Could not send the report to the GitHub CLI.".to_owned())?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|_| "The GitHub CLI (gh) did not finish.".to_owned())?;
    if !output.status.success() {
        return Err(gh_failure_reason(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_created(stdout: &str) -> Option<ReportedIssue> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    Some(ReportedIssue {
        number: value.get("number")?.as_i64()?,
        url: value.get("html_url")?.as_str()?.to_owned(),
    })
}

/// Serializes reports so a double click cannot create two issues.
static REPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn report_bug_with<F, Fut>(
    fingerprint: &str,
    screen: &str,
    create: F,
) -> Result<ReportedIssue, (StatusCode, String)>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let _guard = REPORT_LOCK.lock().await;
    let error = app_errors::find(fingerprint)
        .ok_or((StatusCode::NOT_FOUND, "This error is no longer active.".into()))?;
    if let Some(issue) = error.issue {
        return Ok(issue);
    }
    let payload = serde_json::to_vec(&serde_json::json!({
        "title": issue_title(&error.message),
        "body": issue_body(&error, screen),
        "labels": ["bug"],
    }))
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Could not build the issue.".into()))?;
    let stdout = create(payload)
        .await
        .map_err(|reason| (StatusCode::BAD_GATEWAY, reason))?;
    let issue = parse_created(&stdout).ok_or((
        StatusCode::BAD_GATEWAY,
        "GitHub answered with an unexpected response.".into(),
    ))?;
    app_errors::set_reported(fingerprint, issue.clone());
    Ok(issue)
}

async fn report_bug(
    Path(fingerprint): Path<String>,
    Json(request): Json<ReportBugRequest>,
) -> Response {
    if !valid_fingerprint(&fingerprint) || request.screen.len() > 512 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match report_bug_with(&fingerprint, &request.screen, run_gh_create).await {
        Ok(issue) => Json(issue).into_response(),
        Err((status, message)) => {
            (status, Json(serde_json::json!({ "message": message }))).into_response()
        }
    }
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
    if !valid_fingerprint(&fingerprint) {
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
    // Analysis context stays server-side; the response always ends, allowing
    // relay signing and WebRTC to serialize it before delivering it to the UI.
    Json(serde_json::json!({ "session_id": session, "errors": errors }))
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

    fn sample(message: &str) -> AppErrorSummary {
        AppErrorSummary {
            fingerprint: "fp-0123456789ab".into(),
            message: message.into(),
            location: "server a.rs:1".into(),
            source: "backend".into(),
            count: 3,
            first_seen: 1_700_000_000_000,
            last_seen: 1_700_000_060_000,
            issue: None,
        }
    }

    #[test]
    fn title_is_single_line_and_trimmed() {
        let title = issue_title(&format!("first line\nsecond {}", "x".repeat(10)));
        assert_eq!(title, "App error: first line");
        let long = issue_title(&"y".repeat(500));
        assert_eq!(long.chars().count(), "App error: ".len() + MAX_TITLE_CHARS + 1);
        assert!(!long.contains('\n'));
    }

    #[test]
    fn body_has_required_fields() {
        let body = issue_body(&sample("boom ``` fence"), "/workspaces/abc");
        assert!(body.contains("boom ``` fence"));
        assert!(body.contains("fp-0123456789ab"));
        assert!(body.contains("2023-11-14T22:13:20Z"));
        assert!(body.contains("2023-11-14T22:14:20Z"));
        assert!(body.contains("Occurrences: 3"));
        assert!(body.contains("/workspaces/abc"));
        assert!(body.contains("server a.rs:1"));
        assert!(body.contains("````\nboom ``` fence\n````"));
    }

    #[tokio::test]
    async fn report_is_idempotent_and_failures_are_retryable() {
        let message = "Report bug idempotency test";
        let location = "server report-bug-test.rs:1";
        let fingerprint = app_errors::fingerprint(message, location);
        assert_eq!(
            report_bug_with(&fingerprint, "/", |_| async { Ok(String::new()) })
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        app_errors::record(message, location, "backend", ErrorContext::default());
        let failed = report_bug_with(&fingerprint, "/", |_| async {
            Err("Could not reach GitHub.".to_owned())
        })
        .await
        .unwrap_err();
        assert_eq!(failed.0, StatusCode::BAD_GATEWAY);
        assert!(app_errors::find(&fingerprint).unwrap().issue.is_none());
        let created = report_bug_with(&fingerprint, "/", |payload| async move {
            let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(v["labels"][0], "bug");
            Ok(r#"{"number":42,"html_url":"https://github.com/mdevel-uy/fluke/issues/42"}"#.into())
        })
        .await
        .unwrap();
        assert_eq!(created.number, 42);
        // A second create call would fail here, so Ok proves it never ran.
        let again = report_bug_with(&fingerprint, "/", |_| async {
            Err("second issue must not be created".to_owned())
        })
        .await
        .unwrap();
        assert_eq!(again, created);
        assert_eq!(app_errors::find(&fingerprint).unwrap().issue, Some(created));
    }

    #[test]
    fn gh_failures_are_readable() {
        assert!(gh_failure_reason("HTTP 403: Forbidden").contains("denied"));
        assert!(gh_failure_reason("To get started with GitHub CLI, please run: gh auth login").contains("session"));
        assert!(gh_failure_reason("dial tcp: lookup api.github.com").contains("reach"));
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
