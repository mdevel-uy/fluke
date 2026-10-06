//! Remote deduplication. C2 must write `Fluke fingerprint: fp-<12 hex>` in
//! the issue body. Search only sends the fingerprint, never logs or context.
use std::{collections::BTreeMap, sync::OnceLock, time::Duration};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub const RECENT_DAYS: i64 = 90;
const TIMEOUT: Duration = Duration::from_secs(4);
const BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
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

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

/// Called only from the finite snapshot route, never from tracing capture.
/// Insert before spawning so concurrent polls and repetitions share one lookup.
pub async fn lookup(fingerprint: &str) -> Lookup {
    let Some(token) = utils::github_token::token() else {
        return Lookup::Disabled;
    };
    let mut cache = cache().lock().await;
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
    tokio::spawn(async move {
        let result = tokio::time::timeout(TIMEOUT, search(token, &fingerprint)).await;
        let mut cache = self::cache().lock().await;
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
    // Serialize distinct lookups; queued work shares the same short deadline.
    static SEARCH: Mutex<()> = Mutex::const_new(());
    let _guard = SEARCH.lock().await;
    if cache()
        .lock()
        .await
        .backoff_until
        .is_some_and(|until| until > tokio::time::Instant::now())
    {
        return Err(());
    }
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
    use serde_json::json;

    use super::*;

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
