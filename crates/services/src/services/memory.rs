//! Fluke's memory (J3, #767): Honcho v3, self-hosted.
//!
//! One workspace (`fluke`), two peers (`user`, `fluke`) and one session: the
//! conversation with Fluke. Every exchange user ↔ Fluke is mirrored there
//! (not the app's event batches nor SILENT replies, D8), and before each turn
//! Honcho's representation of the user, searched by the message, comes in
//! the turn's context as `[MEMORY]`. Honcho does the reasoning (its own LLM
//! key lives in Honcho's `.env`, not here).
//!
//! Memory is optional: without Honcho, or when it is slow or down, Fluke
//! works the same without it. A failure backs off for a minute so a missing
//! Honcho never adds latency to every turn.

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

const WORKSPACE: &str = "fluke";
const SESSION: &str = "fluke-main";
const USER: &str = "user";
const FLUKE: &str = "fluke";
/// Recall happens before every turn: it has to be quick or skipped.
const RECALL_TIMEOUT: Duration = Duration::from_millis(1500);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF: Duration = Duration::from_secs(60);
const RECALL_MAX: usize = 4000;
/// Honcho rejects messages longer than this.
const MESSAGE_MAX: usize = 25_000;

/// `FLUKE_HONCHO_URL` (default `http://127.0.0.1:8000`); `FLUKE_HONCHO_URL=off`
/// disables memory. `FLUKE_HONCHO_TOKEN` when Honcho runs with auth.
fn base_url() -> Option<String> {
    let url = std::env::var("FLUKE_HONCHO_URL").unwrap_or_else(|_| "http://127.0.0.1:8000".into());
    let url = url.trim().trim_end_matches('/').to_string();
    (!url.is_empty() && url != "off").then_some(url)
}

#[derive(Default)]
struct State {
    ready: bool,
    down_until: Option<Instant>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

fn backing_off() -> bool {
    state()
        .lock()
        .ok()
        .and_then(|s| s.down_until)
        .is_some_and(|until| Instant::now() < until)
}

fn mark_down(reason: &str) {
    tracing::debug!("Fluke memory (Honcho) unavailable: {reason}");
    if let Ok(mut s) = state().lock() {
        s.ready = false;
        s.down_until = Some(Instant::now() + BACKOFF);
    }
}

async fn post(base: &str, path: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    let mut request = reqwest::Client::new()
        .post(format!("{base}/v3{path}"))
        .timeout(timeout)
        .json(&body);
    if let Ok(token) = std::env::var("FLUKE_HONCHO_TOKEN")
        && !token.trim().is_empty()
    {
        request = request.bearer_auth(token.trim());
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Workspace, peers and session, once per server run (all get-or-create).
async fn ensure(base: &str) -> Result<(), String> {
    if state().lock().map(|s| s.ready).unwrap_or(false) {
        return Ok(());
    }
    post(base, "/workspaces", json!({ "id": WORKSPACE }), WRITE_TIMEOUT).await?;
    for peer in [USER, FLUKE] {
        post(base, &format!("/workspaces/{WORKSPACE}/peers"), json!({ "id": peer }), WRITE_TIMEOUT)
            .await?;
    }
    post(
        base,
        &format!("/workspaces/{WORKSPACE}/sessions"),
        json!({
            "id": SESSION,
            // Honcho learns about the user, not about Fluke.
            "peers": {
                USER: { "observe_me": true },
                FLUKE: { "observe_me": false },
            }
        }),
        WRITE_TIMEOUT,
    )
    .await?;
    if let Ok(mut s) = state().lock() {
        s.ready = true;
        s.down_until = None;
    }
    Ok(())
}

/// What Fluke knows about the user that matters for `query`; `None` without
/// memory (no Honcho, down, slow, or nothing learned yet).
pub async fn recall(query: &str) -> Option<String> {
    let base = base_url()?;
    if backing_off() {
        return None;
    }
    let attempt = async {
        ensure(&base).await?;
        post(
            &base,
            &format!("/workspaces/{WORKSPACE}/peers/{USER}/representation"),
            json!({
                "search_query": query.chars().take(2000).collect::<String>(),
                "search_top_k": 10,
                "include_most_frequent": true,
                "max_conclusions": 15,
            }),
            RECALL_TIMEOUT,
        )
        .await
    };
    match tokio::time::timeout(RECALL_TIMEOUT * 2, attempt).await {
        Ok(Ok(v)) => representation_text(&v),
        Ok(Err(e)) => {
            mark_down(&e);
            None
        }
        Err(_) => {
            mark_down("timeout");
            None
        }
    }
}

fn representation_text(response: &Value) -> Option<String> {
    let text = response.get("representation")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(if text.len() > RECALL_MAX {
        let cut = (0..=RECALL_MAX).rev().find(|&i| text.is_char_boundary(i)).unwrap_or(0);
        format!("{}…", &text[..cut])
    } else {
        text.to_string()
    })
}

/// Mirror one exchange (fire and forget).
pub fn remember(user_text: String, fluke_reply: String) {
    let Some(base) = base_url() else { return };
    if backing_off() {
        return;
    }
    tokio::spawn(async move {
        let clip = |s: String| s.chars().take(MESSAGE_MAX).collect::<String>();
        let result = async {
            ensure(&base).await?;
            post(
                &base,
                &format!("/workspaces/{WORKSPACE}/sessions/{SESSION}/messages"),
                json!({
                    "messages": [
                        { "content": clip(user_text), "peer_id": USER },
                        { "content": clip(fluke_reply), "peer_id": FLUKE },
                    ]
                }),
                WRITE_TIMEOUT,
            )
            .await
        }
        .await;
        if let Err(e) = result {
            mark_down(&e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn representation_is_trimmed_and_optional() {
        assert_eq!(representation_text(&json!({ "representation": "  " })), None);
        assert_eq!(representation_text(&json!({})), None);
        assert_eq!(
            representation_text(&json!({ "representation": " Prefiere device flow. " })).as_deref(),
            Some("Prefiere device flow.")
        );
        let long = representation_text(&json!({ "representation": "ñ".repeat(5000) })).unwrap();
        assert!(long.len() <= RECALL_MAX + "…".len() && long.ends_with('…'));
    }

    #[tokio::test]
    async fn without_honcho_memory_is_silent_and_fast() {
        // Nothing listens on this port: recall gives up and backs off.
        // SAFETY: tests in this module do not read the variable concurrently.
        unsafe { std::env::set_var("FLUKE_HONCHO_URL", "http://127.0.0.1:9") };
        let started = Instant::now();
        assert_eq!(recall("hola").await, None);
        assert!(started.elapsed() < RECALL_TIMEOUT * 3);
        assert!(backing_off());
        let started = Instant::now();
        assert_eq!(recall("hola").await, None);
        assert!(started.elapsed() < Duration::from_millis(50), "backoff skips the call");
    }
}
