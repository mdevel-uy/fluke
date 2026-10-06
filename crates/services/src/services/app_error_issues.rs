//! Remote deduplication. C2 must write `Fluke fingerprint: fp-<12 hex>` in
//! the issue body. Search only sends the fingerprint, never logs or context.
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub const RECENT_DAYS: i64 = 90;
const TIMEOUT: Duration = Duration::from_secs(4);
const BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Lookup {
    Checking,
    Existing { url: String },
    Missing,
    Disabled,
    Failed,
}

#[derive(Default)]
struct Cache {
    results: BTreeMap<String, Lookup>,
    backoff_until: Option<tokio::time::Instant>,
}

#[derive(Default)]
struct Session {
    cache: Mutex<Cache>,
    search: Mutex<()>,
}

/// Called only from the finite snapshot route, never from tracing capture.
/// Insert before spawning so concurrent polls and repetitions share one lookup.
pub async fn lookup(fingerprint: &str) -> Lookup {
    static SESSION: OnceLock<Arc<Session>> = OnceLock::new();
    let session = SESSION.get_or_init(|| Arc::new(Session::default())).clone();
    lookup_with(
        session,
        fingerprint,
        utils::github_token::token(),
        |token, fingerprint| async move { search(token, &fingerprint).await },
    )
    .await
}

// The same scheduler is used with a controlled transport in tests; each test
// owns its session and Tokio clock, without global state or real credentials.
async fn lookup_with<F, Fut>(
    session: Arc<Session>,
    fingerprint: &str,
    token: Option<&'static str>,
    transport: F,
) -> Lookup
where
    F: FnOnce(&'static str, String) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Option<String>, ()>> + Send + 'static,
{
    let Some(token) = token else {
        return Lookup::Disabled;
    };
    let mut cache = session.cache.lock().await;
    if let Some(result) = cache.results.get(fingerprint) {
        return result.clone();
    }
    // Bound session memory and request volume during storms of distinct errors.
    // Once full, new errors still appear, but cannot offer issue creation.
    if cache.results.len() >= 1000 {
        return Lookup::Failed;
    }
    if cache
        .backoff_until
        .is_some_and(|until| until > tokio::time::Instant::now())
    {
        cache.results.insert(fingerprint.into(), Lookup::Failed);
        return Lookup::Failed;
    }
    cache.results.insert(fingerprint.into(), Lookup::Checking);
    let fingerprint = fingerprint.to_owned();
    drop(cache);
    tokio::spawn(async move {
        let result = tokio::time::timeout(TIMEOUT, async {
            // Queue time counts toward the deadline. Recheck backoff after
            // acquiring the gate so queued work cannot bypass a failed request.
            let _guard = session.search.lock().await;
            if session
                .cache
                .lock()
                .await
                .backoff_until
                .is_some_and(|until| until > tokio::time::Instant::now())
            {
                return Err(());
            }
            let result = transport(token, fingerprint.clone()).await;
            if result.is_err() {
                session.cache.lock().await.backoff_until =
                    Some(tokio::time::Instant::now() + BACKOFF);
            }
            result
        })
        .await;
        let mut cache = session.cache.lock().await;
        let lookup = match result {
            Ok(Ok(Some(url))) => Lookup::Existing { url },
            Ok(Ok(None)) => Lookup::Missing,
            _ => {
                cache.backoff_until = Some(tokio::time::Instant::now() + BACKOFF);
                Lookup::Failed
            }
        };
        cache.results.insert(fingerprint, lookup);
    });
    Lookup::Checking
}

fn query(fingerprint: &str, closed: bool, cutoff: DateTime<Utc>) -> String {
    let state = if closed {
        format!("is:closed closed:>={}", cutoff.format("%Y-%m-%d"))
    } else {
        "is:open".into()
    };
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
    number: u64,
    body: Option<String>,
    state: String,
    closed_at: Option<DateTime<Utc>>,
    pull_request: Option<serde_json::Value>,
}

fn parse(
    response: SearchResponse,
    fingerprint: &str,
    cutoff: DateTime<Utc>,
) -> Result<Option<String>, ()> {
    if response.incomplete_results || response.total_count > response.items.len() {
        // Never treat truncated/incomplete search as proof that no issue exists.
        return Err(());
    }
    Ok(response
        .items
        .into_iter()
        .find(|issue| {
            issue.pull_request.is_none()
                && issue.number > 0
                && issue.body.as_deref().is_some_and(|body| {
                    body.split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                        .any(|word| word == fingerprint)
                })
                && (issue.state == "open"
                    || (issue.state == "closed"
                        && issue.closed_at.is_some_and(|closed| closed >= cutoff)))
        })
        .map(|issue| format!("https://github.com/mdevel-uy/fluke/issues/{}", issue.number)))
}

async fn search(token: &str, fingerprint: &str) -> Result<Option<String>, ()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| ())?;
    let cutoff = Utc::now() - chrono::Duration::days(RECENT_DAYS);
    for closed in [false, true] {
        let response = client
            .get("https://api.github.com/search/issues")
            .bearer_auth(token)
            .header("User-Agent", "Fluke-app-error-dedup")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .query(&[
                ("q", query(fingerprint, closed, cutoff)),
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
            return Ok(Some(url));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;

    // Give spawned tasks a turn without advancing the paused clock.
    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_polls_share_one_search_and_cache_success() {
        for result in [
            None,
            Some("https://github.com/mdevel-uy/fluke/issues/42".into()),
        ] {
            let session = Arc::new(Session::default());
            let calls = Arc::new(AtomicUsize::new(0));
            let release = Arc::new(tokio::sync::Notify::new());
            let polls = (0..20).map(|_| {
                let calls = calls.clone();
                let release = release.clone();
                let result = result.clone();
                lookup_with(
                    session.clone(),
                    "fp-0123456789ab",
                    Some("test-token"),
                    move |_, _| async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        release.notified().await;
                        Ok(result)
                    },
                )
            });
            let outcomes = futures::future::join_all(polls).await;
            assert!(outcomes.iter().all(|value| *value == Lookup::Checking));
            settle().await;
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            release.notify_one();
            settle().await;
            let expected = result.map_or(Lookup::Missing, |url| Lookup::Existing { url });
            for _ in 0..3 {
                assert_eq!(
                    lookup_with(
                        session.clone(),
                        "fp-0123456789ab",
                        Some("test-token"),
                        |_, _| async { panic!("cached result must not retry") }
                    )
                    .await,
                    expected
                );
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_includes_queued_work_and_failures_never_retry() {
        let session = Arc::new(Session::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let started = tokio::time::Instant::now();
        for fp in ["fp-0123456789ab", "fp-0123456789ac"] {
            let calls = calls.clone();
            assert_eq!(
                lookup_with(
                    session.clone(),
                    fp,
                    Some("test-token"),
                    move |_, _| async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::future::pending::<Result<Option<String>, ()>>().await
                    }
                )
                .await,
                Lookup::Checking
            );
        }
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(TIMEOUT - Duration::from_millis(1)).await;
        settle().await;
        assert!(
            session
                .cache
                .lock()
                .await
                .results
                .values()
                .all(|value| *value == Lookup::Checking)
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(tokio::time::Instant::now() - started, TIMEOUT);
        for fp in ["fp-0123456789ab", "fp-0123456789ac", "fp-0123456789ad"] {
            assert_eq!(
                lookup_with(session.clone(), fp, Some("test-token"), |_, _| async {
                    panic!("timeout or backoff must not retry")
                })
                .await,
                Lookup::Failed
            );
        }
        tokio::time::advance(BACKOFF).await;
        assert_eq!(
            lookup_with(
                session.clone(),
                "fp-0123456789ab",
                Some("test-token"),
                |_, _| async { panic!("session failure remains cached") }
            )
            .await,
            Lookup::Failed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn http_failures_block_queued_and_new_requests_until_backoff_expires() {
        for status in [401, 403, 429] {
            let session = Arc::new(Session::default());
            let release = Arc::new(tokio::sync::Notify::new());
            let gate = release.clone();
            assert_eq!(
                lookup_with(
                    session.clone(),
                    "fp-0123456789ab",
                    Some("test-token"),
                    move |_, _| async move {
                        gate.notified().await;
                        // Simulate the transport's error_for_status failure for each
                        // authentication/rate-limit response, without contacting GitHub.
                        let status = reqwest::StatusCode::from_u16(status).unwrap();
                        assert!(status.is_client_error());
                        Err(())
                    }
                )
                .await,
                Lookup::Checking
            );
            settle().await;
            assert_eq!(
                lookup_with(
                    session.clone(),
                    "fp-0123456789ac",
                    Some("test-token"),
                    |_, _| async { panic!("queued transport bypassed backoff") }
                )
                .await,
                Lookup::Checking
            );
            settle().await;
            release.notify_one();
            settle().await;
            for fp in ["fp-0123456789ab", "fp-0123456789ac", "fp-0123456789ad"] {
                assert_eq!(
                    lookup_with(session.clone(), fp, Some("test-token"), |_, _| async {
                        panic!("failure/backoff must not send a request")
                    })
                    .await,
                    Lookup::Failed
                );
            }
            tokio::time::advance(BACKOFF - Duration::from_millis(1)).await;
            assert_eq!(
                lookup_with(
                    session.clone(),
                    "fp-0123456789ae",
                    Some("test-token"),
                    |_, _| async { panic!("backoff ended early") }
                )
                .await,
                Lookup::Failed
            );
            tokio::time::advance(Duration::from_millis(1)).await;
            assert_eq!(
                lookup_with(
                    session.clone(),
                    "fp-0123456789ab",
                    Some("test-token"),
                    |_, _| async { panic!("HTTP failure remains cached after backoff expires") }
                )
                .await,
                Lookup::Failed
            );
            assert_eq!(
                lookup_with(
                    session.clone(),
                    "fp-0123456789af",
                    Some("test-token"),
                    |_, _| async { Ok(None) }
                )
                .await,
                Lookup::Checking
            );
            settle().await;
            assert_eq!(
                session.cache.lock().await.results["fp-0123456789af"],
                Lookup::Missing
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn absent_token_disables_lookup_without_transport_or_cache_entries() {
        let session = Arc::new(Session::default());
        assert_eq!(
            lookup_with(session.clone(), "fp-0123456789ab", None, |_, _| async {
                panic!("disabled lookup must not send a request")
            })
            .await,
            Lookup::Disabled
        );
        assert!(session.cache.lock().await.results.is_empty());
    }

    #[test]
    fn queries_scope_repository_body_and_closed_window() {
        let cutoff = DateTime::parse_from_rfc3339("2026-07-08T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            query("fp-0123456789ab", false, cutoff),
            "repo:mdevel-uy/fluke is:issue in:body \"fp-0123456789ab\" is:open"
        );
        assert!(query("fp-0123456789ab", true, cutoff).ends_with("is:closed closed:>=2026-07-08"));
    }

    #[test]
    fn simulated_results_require_exact_fingerprint_and_recent_issue() {
        let cutoff = Utc::now() - chrono::Duration::days(RECENT_DAYS);
        let fp = "fp-0123456789ab";
        let issue = json!({"number": 42, "body": format!("Fluke fingerprint: {fp}"), "state": "open", "closed_at": null});
        let check = |issue: serde_json::Value| {
            parse(
                serde_json::from_value(
                    json!({"total_count": 1, "incomplete_results": false, "items": [issue]}),
                )
                .unwrap(),
                fp,
                cutoff,
            )
            .unwrap()
        };
        assert_eq!(
            check(issue.clone()).as_deref(),
            Some("https://github.com/mdevel-uy/fluke/issues/42")
        );
        let mut closed = issue.clone();
        closed["state"] = json!("closed");
        closed["closed_at"] = json!(Utc::now());
        assert!(check(closed.clone()).is_some());
        closed["closed_at"] = json!(cutoff - chrono::Duration::seconds(1));
        assert!(check(closed).is_none());
        let mut wrong = issue.clone();
        wrong["body"] = json!(format!("{fp}0"));
        assert!(check(wrong).is_none());
        let mut pr = issue;
        pr["pull_request"] = json!({});
        assert!(check(pr).is_none());
        assert!(
            parse(
                serde_json::from_value(
                    json!({"total_count": 0, "incomplete_results": true, "items": []})
                )
                .unwrap(),
                fp,
                cutoff
            )
            .is_err()
        );
        assert!(
            parse(
                serde_json::from_value(
                    json!({"total_count": 101, "incomplete_results": false, "items": []})
                )
                .unwrap(),
                fp,
                cutoff
            )
            .is_err()
        );
    }
}
