//! GitHub deduplication for app failures. Never logs or exposes credentials.
//! C2 must put `Fluke fingerprint: fp-xxxxxxxxxxxx` in the issue body.
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use utils::app_error_issues::Lookup;

pub const RECENT_DAYS: i64 = 90;
const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CACHE: usize = 4096;

struct Cached {
    result: Lookup,
    started: Instant,
}
#[derive(Default)]
struct Cache {
    entries: BTreeMap<String, Cached>,
    backoff: Option<Instant>,
    budget_window: Option<Instant>,
    searches: usize,
}
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Called by finite snapshots, outside tracing/panic capture. At most one task
/// per fingerprint, including failed results; eviction never restarts searches.
pub fn lookup(fingerprint: &str) -> Lookup {
    let Some(token) = utils::app_error_issues::token() else {
        return Lookup::Disabled;
    };
    lookup_with(cache(), fingerprint, move |fingerprint| async move {
        search(token, &fingerprint).await
    })
}

fn lookup_with<F>(
    state: &'static Mutex<Cache>,
    fingerprint: &str,
    search: impl FnOnce(String) -> F,
) -> Lookup
where
    F: std::future::Future<Output = Result<Lookup, ()>> + Send + 'static,
{
    let Ok(mut cache) = state.lock() else {
        return Lookup::Failed;
    };
    if let Some(entry) = cache.entries.get_mut(fingerprint) {
        // Self-repair if the task/runtime stopped halfway through a lookup.
        if matches!(entry.result, Lookup::Checking) && entry.started.elapsed() >= TIMEOUT {
            entry.result = Lookup::Failed;
        }
        return entry.result.clone();
    }
    if cache.entries.len() >= MAX_CACHE {
        return Lookup::Failed;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return Lookup::Failed;
    };
    if cache
        .budget_window
        .is_none_or(|start| start.elapsed() >= Duration::from_secs(60))
    {
        cache.budget_window = Some(Instant::now());
        cache.searches = 0;
    }
    let blocked = cache.backoff.is_some_and(|until| until > Instant::now()) || cache.searches >= 10;
    cache.entries.insert(
        fingerprint.into(),
        Cached {
            result: if blocked {
                Lookup::Failed
            } else {
                Lookup::Checking
            },
            started: Instant::now(),
        },
    );
    if blocked {
        return Lookup::Failed;
    }
    // Reserve the search budget before spawning: other errors degrade safely
    // instead of issuing a burst (GitHub's search budget is separate).
    cache.searches += 1;
    let fingerprint = fingerprint.to_owned();
    let future = search(fingerprint.clone());
    runtime.spawn(finish_lookup(state, fingerprint, future, TIMEOUT));
    Lookup::Checking
}

async fn finish_lookup(
    state: &Mutex<Cache>,
    fingerprint: String,
    future: impl std::future::Future<Output = Result<Lookup, ()>>,
    timeout: Duration,
) {
    let result = tokio::time::timeout(timeout, future).await;
    let lookup = match result {
        Ok(Ok(value)) => value,
        _ => Lookup::Failed,
    };
    if let Ok(mut cache) = state.lock() {
        if matches!(lookup, Lookup::Failed) {
            cache.backoff = Some(Instant::now() + Duration::from_secs(60));
        }
        if let Some(entry) = cache.entries.get_mut(&fingerprint) {
            entry.result = lookup;
        }
    }
}

/// Enrich finite snapshots; capture and credentials stay in utils.
pub fn snapshot() -> (u64, Vec<utils::app_errors::AppErrorSummary>) {
    let (revision, mut errors) = utils::app_errors::snapshot();
    for error in &mut errors {
        error.issue_lookup = lookup(&error.fingerprint);
    }
    (revision, errors)
}

fn query(fingerprint: &str, closed_since: Option<DateTime<Utc>>) -> String {
    let state = closed_since.map_or_else(
        || "is:open".into(),
        |date| format!("is:closed closed:>={}", date.format("%Y-%m-%d")),
    );
    format!("repo:mdevel-uy/fluke is:issue in:body \"{fingerprint}\" {state}")
}

#[derive(Deserialize)]
struct SearchResponse {
    total_count: usize,
    incomplete_results: bool,
    items: Vec<Issue>,
}
#[derive(Deserialize)]
struct Issue {
    body: Option<String>,
    html_url: String,
    state: String,
    closed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

fn parse(
    response: SearchResponse,
    fingerprint: &str,
    cutoff: DateTime<Utc>,
) -> Result<Option<String>, ()> {
    for issue in &response.items {
        let exact = issue.body.as_deref().is_some_and(|body| {
            body.split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
                .any(|word| word == fingerprint)
        });
        let eligible = issue.state == "open"
            || (issue.state == "closed" && issue.closed_at.is_some_and(|date| date >= cutoff));
        let safe_url = issue
            .html_url
            .strip_prefix("https://github.com/mdevel-uy/fluke/issues/")
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
        if exact && eligible && safe_url && issue.pull_request.is_none() {
            return Ok(Some(issue.html_url.clone()));
        }
    }
    // Incomplete/truncated search cannot safely mean "missing".
    if response.incomplete_results || response.total_count > response.items.len() {
        Err(())
    } else {
        Ok(None)
    }
}

async fn search(token: &str, fingerprint: &str) -> Result<Lookup, ()> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("fluke-app-error-dedup")
        .build()
        .map_err(|_| ())?;
    let cutoff = Utc::now() - chrono::Duration::days(RECENT_DAYS);
    for closed in [None, Some(cutoff)] {
        let response = client
            .get("https://api.github.com/search/issues")
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .query(&[
                ("q", query(fingerprint, closed)),
                ("per_page", "100".into()),
            ])
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?
            .json::<SearchResponse>()
            .await
            .map_err(|_| ())?;
        if let Some(url) = parse(response, fingerprint, cutoff)? {
            return Ok(Lookup::Existing { url });
        }
    }
    Ok(Lookup::Missing)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn isolated_cache() -> &'static Mutex<Cache> {
        // Each test owns its session; never mutate the production global cache.
        Box::leak(Box::new(Mutex::new(Cache::default())))
    }

    #[tokio::test]
    async fn concurrent_snapshots_start_one_search_and_reuse_result() {
        let state = isolated_cache();
        let starts = AtomicUsize::new(0);
        let runtime = tokio::runtime::Handle::current();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let runtime = &runtime;
                let starts = &starts;
                scope.spawn(move || {
                    let _entered = runtime.enter();
                    assert_eq!(
                        lookup_with(state, "fp-0123456789ab", |_| {
                            starts.fetch_add(1, Ordering::Relaxed);
                            std::future::ready(Ok(Lookup::Existing {
                                url: "https://github.com/mdevel-uy/fluke/issues/42".into(),
                            }))
                        }),
                        Lookup::Checking
                    );
                });
            }
        });
        assert_eq!(starts.load(Ordering::Relaxed), 1);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if !matches!(
                    state.lock().unwrap().entries["fp-0123456789ab"].result,
                    Lookup::Checking
                ) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for _ in 0..3 {
            assert_eq!(
                lookup_with(state, "fp-0123456789ab", |_| {
                    panic!("cached snapshots must not start another search");
                    #[allow(unreachable_code)]
                    std::future::ready(Err(()))
                }),
                Lookup::Existing {
                    url: "https://github.com/mdevel-uy/fluke/issues/42".into(),
                }
            );
        }
    }

    #[tokio::test]
    async fn timeout_and_backoff_fail_closed_without_retries() {
        let state = isolated_cache();
        state.lock().unwrap().entries.insert(
            "timeout".into(),
            Cached {
                result: Lookup::Checking,
                started: Instant::now(),
            },
        );
        finish_lookup(
            state,
            "timeout".into(),
            std::future::pending(),
            Duration::ZERO,
        )
        .await;
        assert_eq!(
            state.lock().unwrap().entries["timeout"].result,
            Lookup::Failed
        );
        for fingerprint in ["timeout", "during-backoff"] {
            assert_eq!(
                lookup_with(state, fingerprint, |_| {
                    panic!("timeout/backoff must not start another search");
                    #[allow(unreachable_code)]
                    std::future::ready(Ok(Lookup::Missing))
                }),
                Lookup::Failed
            );
        }
        // A later snapshot still reuses the failure, even after backoff expires.
        state.lock().unwrap().backoff = None;
        assert_eq!(
            lookup_with(state, "during-backoff", |_| std::future::ready(Ok(
                Lookup::Missing
            ))),
            Lookup::Failed
        );
    }

    #[tokio::test]
    async fn cancelled_task_and_exhausted_budget_never_mean_missing() {
        let state = isolated_cache();
        state.lock().unwrap().entries.insert(
            "cancelled".into(),
            Cached {
                result: Lookup::Checking,
                started: Instant::now() - TIMEOUT,
            },
        );
        let task = tokio::spawn(finish_lookup(
            state,
            "cancelled".into(),
            std::future::pending(),
            TIMEOUT,
        ));
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        // Advancing the stored monotonic start avoids a real three-second wait.
        // A cancelled task leaves Checking; the next snapshot must repair it.
        assert_eq!(
            state.lock().unwrap().entries["cancelled"].result,
            Lookup::Checking
        );
        assert_eq!(
            lookup_with(state, "cancelled", |_| std::future::ready(Ok(
                Lookup::Missing
            ))),
            Lookup::Failed
        );
        {
            let mut cache = state.lock().unwrap();
            cache.budget_window = Some(Instant::now());
            cache.searches = 10;
        }
        assert_eq!(
            lookup_with(state, "over-budget", |_| {
                panic!("budget must be reserved before spawning");
                #[allow(unreachable_code)]
                std::future::ready(Ok(Lookup::Missing))
            }),
            Lookup::Failed
        );
        state.lock().unwrap().searches = 0;
        assert_eq!(
            lookup_with(state, "over-budget", |_| std::future::ready(Ok(
                Lookup::Missing
            ))),
            Lookup::Failed
        );
    }

    #[test]
    fn empty_results_and_untrusted_links() {
        let cutoff = "2026-07-09T00:00:00Z".parse().unwrap();
        let empty = serde_json::from_value(serde_json::json!({
            "total_count":0,"incomplete_results":false,"items":[]
        }))
        .unwrap();
        assert_eq!(parse(empty, "fp-0123456789ab", cutoff), Ok(None));
        for (url, pr) in [
            ("https://example.com/42", serde_json::Value::Null),
            (
                "https://github.com/mdevel-uy/fluke/issues/42",
                serde_json::json!({}),
            ),
        ] {
            let response = serde_json::from_value(serde_json::json!({
                "total_count":1,"incomplete_results":false,"items":[{
                    "body":"fp-0123456789ab","state":"open","closed_at":null,
                    "html_url":url,"pull_request":pr
                }]
            }))
            .unwrap();
            assert_eq!(parse(response, "fp-0123456789ab", cutoff), Ok(None));
        }
    }
    #[test]
    fn queries_scope_repo_body_state_and_window() {
        let date = "2026-07-09T00:00:00Z".parse().unwrap();
        assert_eq!(
            query("fp-0123456789ab", None),
            "repo:mdevel-uy/fluke is:issue in:body \"fp-0123456789ab\" is:open"
        );
        assert!(query("fp-0123456789ab", Some(date)).ends_with("is:closed closed:>=2026-07-09"));
    }
    #[test]
    fn exact_results_and_fail_closed() {
        let cutoff = "2026-07-09T00:00:00Z".parse().unwrap();
        for (state, closed, body, expected) in [
            ("open", None, "Fluke fingerprint: fp-0123456789ab", true),
            (
                "closed",
                Some("2026-07-10T00:00:00Z"),
                "fp-0123456789ab",
                true,
            ),
            (
                "closed",
                Some("2026-07-08T23:59:59Z"),
                "fp-0123456789ab",
                false,
            ),
            ("open", None, "fp-0123456789abc", false),
        ] {
            let response = serde_json::from_value(serde_json::json!({"total_count":1,"incomplete_results":false,"items":[{
                "body":body,"state":state,"closed_at":closed,"html_url":"https://github.com/mdevel-uy/fluke/issues/42"
            }]})).unwrap();
            assert_eq!(
                parse(response, "fp-0123456789ab", cutoff)
                    .unwrap()
                    .is_some(),
                expected
            );
        }
        for (total, incomplete) in [(1, false), (0, true)] {
            let response = serde_json::from_value(
                serde_json::json!({"total_count":total,"incomplete_results":incomplete,"items":[]}),
            )
            .unwrap();
            assert!(parse(response, "fp-0123456789ab", cutoff).is_err());
        }
    }
}
