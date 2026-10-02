//! Where the Claude CLI keeps the subscription (OAuth) login. Shared by the
//! server (connection status, usage card) and the executor (model discovery).

use std::path::PathBuf;

/// `$CLAUDE_CONFIG_DIR`, or `~/.claude`.
pub fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR")
        && !dir.trim().is_empty()
    {
        return Some(PathBuf::from(dir));
    }
    dirs::home_dir().map(|home| home.join(".claude"))
}

/// `$CLAUDE_CONFIG_DIR/.credentials.json`, or `~/.claude/.credentials.json`.
pub fn claude_credentials_path() -> Option<PathBuf> {
    claude_config_dir().map(|dir| dir.join(".credentials.json"))
}

/// Raw credentials JSON stored by `claude login`: the credentials file, then
/// (on macOS, where the CLI keeps it in the Keychain) `security`.
pub async fn read_stored_credentials_json() -> Option<String> {
    if let Some(path) = claude_credentials_path()
        && let Ok(raw) = tokio::fs::read_to_string(path).await
    {
        return Some(raw);
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = tokio::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .await
            && output.status.success()
            && let Ok(raw) = String::from_utf8(output.stdout)
        {
            return Some(raw.trim().to_string());
        }
    }

    None
}

/// `accessToken` from the credentials JSON
/// (`{"claudeAiOauth":{"accessToken":..}}`, or the bare inner object).
pub fn access_token_from_json(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth").unwrap_or(&value);
    oauth
        .get("accessToken")?
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// Subscription access token: `CLAUDE_CODE_OAUTH_TOKEN`, then the login
/// stored by `claude login` (file or macOS Keychain).
pub async fn subscription_access_token() -> Option<String> {
    if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN")
        && !token.trim().is_empty()
    {
        return Some(token);
    }
    access_token_from_json(&read_stored_credentials_json().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_token_parsing() {
        assert_eq!(
            access_token_from_json(r#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":1}}"#),
            Some("tok".to_string())
        );
        assert_eq!(
            access_token_from_json(r#"{"accessToken":"tok"}"#),
            Some("tok".to_string())
        );
        assert_eq!(
            access_token_from_json(r#"{"claudeAiOauth":{"accessToken":" "}}"#),
            None
        );
        assert_eq!(access_token_from_json("{}"), None);
        assert_eq!(access_token_from_json("not json"), None);
    }
}
