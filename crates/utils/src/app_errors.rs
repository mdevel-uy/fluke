//! Session-local app failures. Never logs from inside the capture path.
//!
//! Contract for #657–#659: Rust computes SHA-256(normalized message|location),
//! prefixed fp- and truncated to 12 hex digits. Message redacts UUIDs, numbers,
//! timestamps, absolute paths and long identifiers. Location retains target,
//! relative file/line, or matched route/status; filesystem prefixes are removed.
//! POST /api/app-errors/report accepts FrontendReport. SSE at
//! /api/app-errors/stream sends {session_id, errors: AppErrorSummary[]}.
//! Analysis context is retained here, never exposed by the summary stream.
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};

use arc_swap::ArcSwap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

const MAX_ERRORS: usize = 50;
const MAX_LOGS: usize = 100;
const MAX_TEXT: usize = 4096;

fn bounded(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

fn summary(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result: String = text.chars().take(300).collect();
    if text.chars().count() > 300 {
        result.push('\u{2026}');
    }
    result
}

pub fn normalize(text: &str) -> String {
    // Order matters: redact compound identifiers before their numbers.
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (
                r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
                "<uuid>",
            ),
            (
                r"\b\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:\d{2})?",
                "<timestamp>",
            ),
            (r#"["'](?:[A-Za-z]:[\\/]|/)[^"']*["']"#, "<path>"),
            (r#"(?:[A-Za-z]:[\\/]|/)[^\s"'<>|,;]+"#, "<path>"),
            (r"(?i)\b[0-9a-f]{16,}\b", "<id>"),
            (r"\b[A-Za-z0-9_-]{24,}\b", "<opaque>"),
            (r"\b\d+(?:\.\d+)?\b", "<number>"),
        ]
        .into_iter()
        .filter_map(|(pattern, replacement)| Regex::new(pattern).ok().map(|r| (r, replacement)))
        .collect()
    });
    let mut result = bounded(text);
    for (regex, replacement) in rules {
        if *replacement == "<opaque>" {
            result = regex
                .replace_all(&result, |captures: &regex::Captures<'_>| {
                    let token = &captures[0];
                    if token.chars().any(|c| c.is_ascii_digit()) {
                        "<id>".to_owned()
                    } else {
                        token.to_owned()
                    }
                })
                .into_owned();
        } else {
            result = regex.replace_all(&result, *replacement).into_owned();
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Backend-only contract: fp- + first 12 hex digits of SHA-256(message|location).
pub fn fingerprint(message: &str, location: &str) -> String {
    let hash = Sha256::digest(format!(
        "{}|{}",
        normalize(message),
        normalized_location(location)
    ));
    format!("fp-{}", &format!("{hash:x}")[..12])
}

/// Keep route, target and source line: they distinguish different failures.
/// Absolute build/home prefixes never participate in the fingerprint.
pub fn normalized_location(location: &str) -> String {
    let location = bounded(location).replace('\\', "/");
    location
        .split_whitespace()
        .map(|part| {
            if let Some(index) = part.find("crates/") {
                return part[index..].to_owned();
            }
            if let Some(index) = part.find("src/") {
                return part[index..].to_owned();
            }
            if part.contains("://")
                || part.starts_with("/home/")
                || part.starts_with("/Users/")
                || (part.starts_with('/') && part.contains('.'))
                || part.as_bytes().get(1) == Some(&b':')
            {
                return part.rsplit('/').next().unwrap_or("").to_owned();
            }
            part.to_owned()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ErrorContext {
    pub fields: BTreeMap<String, String>,
    pub spans: Vec<BTreeMap<String, String>>,
    pub logs: Vec<String>,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub fingerprint: String,
    pub message: String,
    pub location: String,
    pub source: String,
    pub first_seen: i64,
    pub context: ErrorContext,
    pub ignored: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppErrorSummary {
    pub fingerprint: String,
    pub message: String,
    pub location: String,
    pub source: String,
    pub count: u64,
    pub first_seen: i64,
    pub last_seen: i64,
}

struct Counters {
    count: AtomicU64,
    last_seen: AtomicI64,
}

struct StoredError {
    error: AppError,
    counters: Arc<Counters>,
}

pub struct Store {
    // The bounded list is published atomically. Repeats update only counters,
    // so readers and other captures never make a repetition disappear.
    errors: ArcSwap<Vec<Arc<StoredError>>>,
    logs: Mutex<VecDeque<String>>,
    revision: AtomicU64,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            errors: ArcSwap::from_pointee(Vec::new()),
            logs: Mutex::new(VecDeque::new()),
            revision: AtomicU64::new(0),
        }
    }
}

impl Store {
    fn repeat(&self, existing: &StoredError, now: i64) {
        let _ =
            existing
                .counters
                .count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                    Some(count.saturating_add(1))
                });
        existing
            .counters
            .last_seen
            .fetch_max(now, Ordering::Relaxed);
        if !existing.error.ignored {
            self.revision.fetch_add(1, Ordering::Release);
        }
    }

    fn record(&self, message: &str, location: &str, source: &str, mut context: ErrorContext) {
        let fingerprint = fingerprint(message, location);
        let now = chrono::Utc::now().timestamp_millis();
        {
            let current = self.errors.load();
            if let Some(existing) = current.iter().find(|e| e.error.fingerprint == fingerprint) {
                self.repeat(existing, now);
                return;
            }
        }
        if source == "frontend" {
            context.logs = self.recent_logs();
        }
        context
            .fields
            .entry("message".into())
            .or_insert_with(|| bounded(message));
        let entry = Arc::new(StoredError {
            error: AppError {
                fingerprint,
                message: summary(message),
                location: bounded(location),
                source: source.into(),
                first_seen: now,
                context,
                ignored: false,
            },
            counters: Arc::new(Counters {
                count: AtomicU64::new(1),
                last_seen: AtomicI64::new(now),
            }),
        });
        // Only new fingerprints compete for publication. Bound retries as well
        // as memory under a storm of distinct errors; repeats take the fast path.
        for _ in 0..MAX_ERRORS {
            let current = self.errors.load();
            if let Some(existing) = current
                .iter()
                .find(|e| e.error.fingerprint == entry.error.fingerprint)
            {
                self.repeat(existing, now);
                return;
            }
            let mut next = (**current).clone();
            if next.len() == MAX_ERRORS {
                // Ignored fingerprints remain session tombstones on overflow.
                let Some(index) = next.iter().position(|e| !e.error.ignored) else {
                    return;
                };
                next.remove(index);
            }
            next.push(entry.clone());
            let previous = self.errors.compare_and_swap(&*current, Arc::new(next));
            if Arc::ptr_eq(&*current, &*previous) {
                self.revision.fetch_add(1, Ordering::Release);
                return;
            }
        }
    }

    fn snapshot(&self) -> (u64, Vec<AppErrorSummary>) {
        let revision = self.revision.load(Ordering::Acquire);
        let errors = self
            .errors
            .load()
            .iter()
            .filter(|e| !e.error.ignored)
            .map(|entry| {
                let e = &entry.error;
                AppErrorSummary {
                    fingerprint: e.fingerprint.clone(),
                    message: e.message.clone(),
                    location: e.location.clone(),
                    source: e.source.clone(),
                    count: entry.counters.count.load(Ordering::Relaxed),
                    first_seen: e.first_seen,
                    last_seen: entry.counters.last_seen.load(Ordering::Relaxed),
                }
            })
            .collect();
        (revision, errors)
    }

    fn ignore(&self, fingerprint: &str) -> bool {
        for _ in 0..MAX_ERRORS {
            let current = self.errors.load();
            let mut next = (**current).clone();
            let now = chrono::Utc::now().timestamp_millis();
            let error = AppError {
                fingerprint: fingerprint.to_owned(),
                message: String::new(),
                location: String::new(),
                source: String::new(),
                first_seen: now,
                context: ErrorContext::default(),
                ignored: true,
            };
            if let Some(index) = next.iter().position(|e| e.error.fingerprint == fingerprint) {
                if next[index].error.ignored {
                    return true;
                }
                // Replacing the entry atomically makes eviction race safely with
                // Ignore. Keep shared counters but release analysis context.
                next[index] = Arc::new(StoredError {
                    error,
                    counters: next[index].counters.clone(),
                });
            } else {
                if next.len() == MAX_ERRORS {
                    let Some(index) = next.iter().position(|e| !e.error.ignored) else {
                        return true;
                    };
                    next.remove(index);
                }
                next.push(Arc::new(StoredError {
                    error,
                    counters: Arc::new(Counters {
                        count: AtomicU64::new(0),
                        last_seen: AtomicI64::new(now),
                    }),
                }));
            }
            let previous = self.errors.compare_and_swap(&*current, Arc::new(next));
            if Arc::ptr_eq(&*current, &*previous) {
                self.revision.fetch_add(1, Ordering::Release);
                return true;
            }
        }
        false
    }

    fn recent_logs(&self) -> Vec<String> {
        self.logs
            .try_lock()
            .map(|logs| logs.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn log(&self, line: &str) {
        if let Ok(mut logs) = self.logs.try_lock() {
            if logs.len() == MAX_LOGS {
                logs.pop_front();
            }
            logs.push_back(bounded(line));
        }
    }
}

pub fn store() -> &'static Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    STORE.get_or_init(Store::default)
}

/// Capture does not take a blocking store lock or publish network traffic.
pub fn record(message: &str, location: &str, source: &str, context: ErrorContext) {
    store().record(message, location, source, context);
}

pub fn snapshot() -> (u64, Vec<AppErrorSummary>) {
    store().snapshot()
}
pub fn ignore(fingerprint: &str) -> bool {
    store().ignore(fingerprint)
}

/// Execution domains are deliberately excluded by tracing target, including
/// their spans. Infrastructure outside these domains still reports failures.
pub fn excluded(target: &str) -> bool {
    if target == "app_errors::http_log" {
        return true;
    }
    [
        "executors",
        "services::services::container",
        "services::services::worker",
        "services::services::mission",
        "local_deployment::container",
        "server::routes::execution_processes",
        "server::routes::workers",
        "server::routes::milestone_runs",
        "server::routes::sessions",
    ]
    .iter()
    .any(|prefix| target.starts_with(prefix))
}

pub fn recent_logs() -> Vec<String> {
    store().recent_logs()
}

#[derive(Default)]
struct Fields(BTreeMap<String, String>);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if self.0.len() < 32 {
            self.0
                .insert(field.name().into(), bounded(&format!("{value:?}")));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if self.0.len() < 32 {
            self.0.insert(field.name().into(), bounded(value));
        }
    }
}

// Collect request errors until status is known. A 5xx has one canonical route
// fingerprint, with the underlying event retained as analysis context.
tokio::task_local! { pub static REQUEST_ERRORS: std::cell::RefCell<Vec<AppError>>; }
tokio::task_local! { pub static REQUEST_EXECUTION_FAILURE: std::cell::Cell<bool>; }

fn mark_execution_failure() {
    let _ = REQUEST_EXECUTION_FAILURE.try_with(|flag| flag.set(true));
}

fn capture(message: &str, location: &str, source: &str, context: ErrorContext) {
    let buffered = REQUEST_ERRORS
        .try_with(|errors| {
            let Ok(mut errors) = errors.try_borrow_mut() else {
                return;
            };
            if errors.len() < MAX_ERRORS {
                errors.push(AppError {
                    fingerprint: String::new(),
                    message: bounded(message),
                    location: bounded(location),
                    source: source.into(),
                    first_seen: 0,
                    context: context.clone(),
                    ignored: false,
                });
            }
        })
        .is_ok();
    if !buffered {
        record(message, location, source, context);
    }
}

pub struct AppErrorLayer;
impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for AppErrorLayer {
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        if let Some(span) = ctx.span(id) {
            let mut fields = Fields::default();
            attrs.record(&mut fields);
            fields
                .0
                .insert("name".into(), attrs.metadata().name().into());
            span.extensions_mut().insert(fields);
        }
    }
    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        ctx: Context<'_, S>,
    ) {
        if let Some(span) = ctx.span(id) {
            if let Some(fields) = span.extensions_mut().get_mut::<Fields>() {
                values.record(fields);
            }
        }
    }
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > tracing::Level::WARN {
            return;
        }
        if excluded(meta.target()) {
            if *meta.level() == tracing::Level::ERROR {
                mark_execution_failure();
            }
            return;
        }
        let mut context = ErrorContext::default();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root().take(16) {
                if excluded(span.metadata().target()) {
                    mark_execution_failure();
                    return;
                }
                if let Some(fields) = span.extensions().get::<Fields>() {
                    context.spans.push(fields.0.clone());
                }
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        let message = fields
            .0
            .get("message")
            .cloned()
            .unwrap_or_else(|| meta.name().into());
        context.fields = fields.0;
        // Generic API conversion events carry the original failure domain.
        if context.fields.get("error_type").is_some_and(|kind| {
            [
                "ExecutorError",
                "ExecutionProcessError",
                "ContainerError",
                "CommandBuildError",
            ]
            .contains(&kind.as_str())
        }) {
            mark_execution_failure();
            return;
        }
        let file = meta.file().unwrap_or("").replace('\\', "/");
        let file = file
            .find("crates/")
            .map(|i| &file[i..])
            .unwrap_or_else(|| file.rsplit('/').next().unwrap_or(""));
        let location = format!("{} {file}:{}", meta.target(), meta.line().unwrap_or(0));
        if *meta.level() == tracing::Level::ERROR {
            context.logs = recent_logs();
            capture(&message, &location, "backend", context);
        }
        store().log(&format!("{} {} {message}", meta.level(), meta.target()));
    }
}

fn current_execution_span() -> bool {
    tracing::Span::current()
        .with_subscriber(|(id, dispatch)| {
            dispatch
                .downcast_ref::<tracing_subscriber::registry::Registry>()
                .and_then(|registry| registry.span(id))
                .is_some_and(|span| span.scope().any(|span| excluded(span.metadata().target())))
        })
        .unwrap_or(false)
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let excluded_span = current_execution_span();
        let execution_file = info.location().is_some_and(|l| {
            let file = l.file().replace('\\', "/");
            file.contains("crates/executors/")
                || file.ends_with("services/container.rs")
                || file.contains("worker_orchestrator")
                || file.ends_with("local-deployment/src/container.rs")
        });
        if !excluded_span && !execution_file {
            let message = info
                .payload()
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| info.payload().downcast_ref::<&str>().copied())
                .unwrap_or("Backend panic");
            let location = info
                .location()
                .map(|l| {
                    let file = l.file().replace('\\', "/");
                    let file = file
                        .find("crates/")
                        .map(|i| &file[i..])
                        .unwrap_or_else(|| file.rsplit('/').next().unwrap_or(""));
                    format!("panic {file}:{}", l.line())
                })
                .unwrap_or_else(|| "panic".into());
            // An unwinding request will not reach middleware's flush, so a
            // panic must be retained immediately rather than request-buffered.
            record(
                message,
                &location,
                "panic",
                ErrorContext {
                    logs: recent_logs(),
                    stack: Some(bounded(
                        &std::backtrace::Backtrace::force_capture().to_string(),
                    )),
                    ..Default::default()
                },
            );
        }
        previous(info);
    }));
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrontendReport {
    pub source: String,
    pub message: String,
    pub stack: Option<String>,
    pub location: Option<String>,
    pub component_stack: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_fingerprints() {
        assert_eq!(
            fingerprint(
                "Failed 42 /home/alice/a UUID 550e8400-e29b-41d4-a716-446655440000",
                "server file.rs:12"
            ),
            fingerprint(
                "Failed 73 C:\\Users\\bob\\b UUID 660e8400-e29b-41d4-a716-446655440001",
                "server file.rs:12"
            )
        );
        assert_eq!(
            normalize("at 2026-10-06T10:23:45Z id abcdef0123456789abcdef0123"),
            normalize("at 2025-01-01T11:24:46Z id fedcba9876543210fedcba9876")
        );
        assert_ne!(
            fingerprint("Database unavailable", "server"),
            fingerprint("Disk full", "server")
        );
        assert_eq!(fingerprint("a", "b").len(), 15);
        assert_ne!(
            fingerprint("API failed", "/api/repos 500"),
            fingerprint("API failed", "/api/config 500")
        );
        assert_ne!(
            fingerprint("failed", "server file.rs:12"),
            fingerprint("failed", "server file.rs:13")
        );
        assert_eq!(
            fingerprint("failed", "server /home/alice/repo/crates/server/file.rs:12"),
            fingerprint(
                "failed",
                "server C:\\Users\\bob\\repo\\crates\\server\\file.rs:12"
            )
        );
    }
    #[test]
    fn repeats_ignore_and_bounds() {
        let store = Store::default();
        store.record("failed 1", "server", "backend", ErrorContext::default());
        let fingerprint = store.snapshot().1[0].fingerprint.clone();
        assert!(store.ignore(&fingerprint));
        store.record("failed 2", "server", "backend", ErrorContext::default());
        assert!(store.snapshot().1.is_empty());
        assert_eq!(
            store.errors.load()[0]
                .counters
                .count
                .load(Ordering::Relaxed),
            2
        );
        for i in 0..100 {
            store.record(
                &format!("failure {}", (b'a' + i % 26) as char),
                &format!("target{}", (b'a' + i / 26) as char),
                "backend",
                ErrorContext::default(),
            );
        }
        assert_eq!(store.errors.load().len(), MAX_ERRORS);
        assert!(
            store
                .errors
                .load()
                .iter()
                .any(|e| e.error.fingerprint == fingerprint)
        );
        let fingerprints: Vec<_> = store
            .snapshot()
            .1
            .iter()
            .map(|e| e.fingerprint.clone())
            .collect();
        for fingerprint in fingerprints {
            assert!(store.ignore(&fingerprint));
        }
        store.record(
            "new distinct failure",
            "new target",
            "backend",
            ErrorContext::default(),
        );
        assert_eq!(store.errors.load().len(), MAX_ERRORS);
        assert!(store.snapshot().1.is_empty());
        for _ in 0..200 {
            store.log("previous warning");
        }
        assert_eq!(store.recent_logs().len(), MAX_LOGS);
    }
    #[test]
    fn concurrent_repeats_are_counted_during_snapshots() {
        let store = Arc::new(Store::default());
        store.record("failure", "server", "backend", ErrorContext::default());
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let store = store.clone();
                scope.spawn(move || {
                    for _ in 0..100 {
                        store.record("failure", "server", "backend", ErrorContext::default());
                        assert_eq!(store.snapshot().1.len(), 1);
                    }
                });
            }
        });
        assert_eq!(store.snapshot().1[0].count, 801);
    }
    #[test]
    fn layer_excludes_execution_and_keeps_context() {
        use tracing_subscriber::prelude::*;
        let subscriber = tracing_subscriber::registry().with(AppErrorLayer);
        REQUEST_ERRORS.sync_scope(std::cell::RefCell::new(Vec::new()), || {
            tracing::subscriber::with_default(subscriber, || {
                tracing::error!(target: "executors::claude", "Agent failed");
                tracing::error!(target: "services::services::worker_orchestrator", "Worker failed");
                {
                    let span = tracing::info_span!(target: "executors::test", "execution");
                    let _entered = span.enter();
                    let nested = tracing::info_span!(target: "server", "nested");
                    let _nested = nested.enter();
                    assert!(current_execution_span());
                    tracing::error!(target: "server", "Failure inside execution span");
                }
                let span = tracing::info_span!(target: "server", "request", request_id = "abc");
                let _entered = span.enter();
                tracing::error!(target: "server", code = 500, "App failed");
            });
            REQUEST_ERRORS.with(|errors| {
                let errors = errors.borrow();
                assert_eq!(errors.len(), 1);
                assert_eq!(errors[0].context.fields["code"], "500");
                assert_eq!(errors[0].context.spans[0]["request_id"], "abc");
            });
        });
    }
}
