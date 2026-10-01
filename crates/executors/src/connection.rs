//! Whether a coding agent is "connected" on this machine, i.e. its CLI has a
//! usable credential. Single source of truth for Settings (the agent-auth
//! endpoint, setup status) and the worker orchestrator's start gate, so the
//! worker form never says "connected" while its tasks fail with "not
//! connected".

use std::path::{Path, PathBuf};

use workspace_utils::claude_credentials::claude_credentials_path;

use crate::executors::{
    BaseCodingAgent,
    claude::{CLAUDE_OAUTH_TOKEN_ENV, claude_oauth_token_path, stored_claude_oauth_token},
    codex::codex_home,
};

fn gemini_env_has_key(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|contents| {
        contents.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("GEMINI_API_KEY=") || trimmed.starts_with("GOOGLE_API_KEY=")
        })
    })
}

fn file_mtime_epoch(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

fn now_epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `{"claudeAiOauth":{"accessToken":..,"refreshToken":..,"expiresAt":<ms>}}`:
/// usable when it has an access token that is unexpired or can be refreshed.
pub fn claude_credentials_usable(raw: &str, now_ms: i64) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let oauth = value.get("claudeAiOauth").unwrap_or(&value);
    let non_empty = |key: &str| {
        oauth
            .get(key)
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
    };
    if !non_empty("accessToken") {
        return false;
    }
    let expired = oauth
        .get("expiresAt")
        .and_then(|v| v.as_i64())
        .is_some_and(|exp| exp <= now_ms);
    !expired || non_empty("refreshToken")
}

/// Claude counts as connected only with credentials the agent can actually
/// use: the subscription token captured by Settings (within its validity),
/// a `CLAUDE_CODE_OAUTH_TOKEN` in the server environment, or a
/// `.credentials.json` that parses and is either unexpired or refreshable.
fn claude_connection_state() -> (bool, Option<i64>) {
    if stored_claude_oauth_token().is_some() {
        return (
            true,
            claude_oauth_token_path().and_then(|p| file_mtime_epoch(&p)),
        );
    }
    if std::env::var(CLAUDE_OAUTH_TOKEN_ENV).is_ok_and(|v| !v.trim().is_empty()) {
        return (true, None);
    }
    let Some(path) = claude_credentials_path() else {
        return (false, None);
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) if claude_credentials_usable(&raw, now_epoch_millis()) => {
            (true, file_mtime_epoch(&path))
        }
        _ => (false, None),
    }
}

/// `(connected, last_auth_epoch)` for the agents that can be connected from
/// Settings (Claude Code, Codex, Gemini); `None` for any other agent.
pub fn connection_state(agent: BaseCodingAgent) -> Option<(bool, Option<i64>)> {
    let candidates: Vec<PathBuf> = match agent {
        BaseCodingAgent::ClaudeCode => return Some(claude_connection_state()),
        BaseCodingAgent::Codex => codex_home()
            .map(|h| h.join("auth.json"))
            .into_iter()
            .collect(),
        BaseCodingAgent::Gemini => dirs::home_dir()
            .map(|h| h.join(".gemini"))
            .map(|g| vec![g.join(".env"), g.join("oauth_creds.json")])
            .unwrap_or_default(),
        _ => return None,
    };
    let mut connected = false;
    let mut last_auth: Option<i64> = None;
    for path in candidates {
        if !path.exists() {
            continue;
        }
        // Gemini's `.env` may exist without our key (edited by hand): only
        // the recognisable variable counts as a credential.
        if path.file_name().and_then(|n| n.to_str()) == Some(".env") && !gemini_env_has_key(&path) {
            continue;
        }
        connected = true;
        if let Some(ts) = file_mtime_epoch(&path) {
            last_auth = Some(last_auth.map_or(ts, |cur| cur.max(ts)));
        }
    }
    Some((connected, last_auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_connection_follows_auth_file() {
        let dir = std::env::temp_dir().join(format!("fluke-codex-home-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: no other test in this crate reads CODEX_HOME.
        unsafe { std::env::set_var("CODEX_HOME", &dir) };
        assert_eq!(
            connection_state(BaseCodingAgent::Codex),
            Some((false, None))
        );
        std::fs::write(dir.join("auth.json"), "{}").unwrap();
        assert!(connection_state(BaseCodingAgent::Codex).unwrap().0);
        std::fs::remove_file(dir.join("auth.json")).unwrap();
        assert!(!connection_state(BaseCodingAgent::Codex).unwrap().0);
        assert_eq!(connection_state(BaseCodingAgent::Amp), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_credentials_usability() {
        let now = 1_000_000;
        let live = r#"{"claudeAiOauth":{"accessToken":"a","expiresAt":2000000}}"#;
        let expired = r#"{"claudeAiOauth":{"accessToken":"a","expiresAt":10}}"#;
        let refreshable =
            r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":10}}"#;
        assert!(claude_credentials_usable(live, now));
        assert!(!claude_credentials_usable(expired, now));
        assert!(claude_credentials_usable(refreshable, now));
        assert!(!claude_credentials_usable("{}", now));
        assert!(!claude_credentials_usable("not json", now));
    }
}
