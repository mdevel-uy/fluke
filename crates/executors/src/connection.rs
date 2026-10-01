//! Whether a coding agent is "connected" on this machine, i.e. its CLI has a
//! credential on disk. Single source of truth for Settings (the agent-auth
//! endpoint) and the worker orchestrator's start gate, so the worker form
//! never says "connected" while its tasks fail with "not connected".

use std::path::{Path, PathBuf};

use crate::executors::{BaseCodingAgent, codex::codex_home};

fn claude_home() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR")
        && !v.trim().is_empty()
    {
        return Some(PathBuf::from(v));
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// Credential files whose presence means the agent is connected; `None` for
/// agents that cannot be connected from Settings.
fn credential_files(agent: BaseCodingAgent) -> Option<Vec<PathBuf>> {
    Some(match agent {
        BaseCodingAgent::ClaudeCode => claude_home()
            .map(|h| h.join(".credentials.json"))
            .into_iter()
            .collect(),
        BaseCodingAgent::Codex => codex_home()
            .map(|h| h.join("auth.json"))
            .into_iter()
            .collect(),
        BaseCodingAgent::Gemini => dirs::home_dir()
            .map(|h| h.join(".gemini"))
            .map(|g| vec![g.join(".env"), g.join("oauth_creds.json")])
            .unwrap_or_default(),
        _ => return None,
    })
}

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

/// `(connected, last_auth_epoch)` for the agents that can be connected from
/// Settings (Claude Code, Codex, Gemini); `None` for any other agent.
pub fn connection_state(agent: BaseCodingAgent) -> Option<(bool, Option<i64>)> {
    let mut connected = false;
    let mut last_auth: Option<i64> = None;
    for path in credential_files(agent)? {
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
}
