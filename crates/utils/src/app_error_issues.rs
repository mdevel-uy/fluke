//! GitHub deduplication for app failures. Never logs or exposes credentials.
//! C2 must put `Fluke fingerprint: fp-xxxxxxxxxxxx` in the issue body.
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const RECENT_DAYS: i64 = 90;
const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CACHE: usize = 4096;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Lookup {
    Checking,
    Existing { url: String },
    Missing,
    Disabled,
    Failed,
}

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
fn token() -> Option<&'static str> {
    option_env!("FLUKE_GITHUB_ISSUES_TOKEN").filter(|value| !value.trim().is_empty())
}

/// Called by finite snapshots, outside tracing/panic capture. At most one task
/// per fingerprint, including failed results; eviction never restarts searches.
pub fn lookup(fingerprint: &str) -> Lookup {
    let Some(token) = token() else {
        return Lookup::Disabled;
    };
    let Ok(mut cache) = cache().lock() else {
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
    runtime.spawn(async move {
        let result = tokio::time::timeout(TIMEOUT, search(token, &fingerprint)).await;
        let lookup = match result {
            Ok(Ok(value)) => value,
            _ => Lookup::Failed,
        };
        if let Ok(mut cache) = self::cache().lock() {
            if matches!(lookup, Lookup::Failed) {
                cache.backoff = Some(Instant::now() + Duration::from_secs(60));
            }
            if let Some(entry) = cache.entries.get_mut(&fingerprint) {
                entry.result = lookup;
            }
        }
    });
    Lookup::Checking
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
    use super::*;
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
