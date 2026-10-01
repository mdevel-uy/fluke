use std::{path::PathBuf, time::Duration};

use serde::Deserialize;
use thiserror::Error;

use crate::model_selector::{ModelInfo, ReasoningOption};

const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
/// Beta flag Claude Code sends alongside subscription (OAuth) bearer tokens.
const ANTHROPIC_OAUTH_BETA: &str = "oauth-2025-04-20";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const PAGE_LIMIT: u32 = 1000;

#[derive(Debug, Error)]
pub enum ModelsFetchError {
    #[error("Claude subscription credential not available")]
    MissingCredential,
    #[error("timed out fetching Anthropic models")]
    Timeout,
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Anthropic API returned status {status}: {body}")]
    Api { status: u16, body: String },
    #[error("failed to parse Anthropic response: {0}")]
    Parse(String),
}

#[derive(Debug, Deserialize)]
struct AnthropicModel {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModel>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeAiOauth>,
}

#[derive(Debug, Deserialize)]
struct ClaudeAiOauth {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

/// Path where the Claude CLI stores the subscription login:
/// `$CLAUDE_CONFIG_DIR/.credentials.json`, or `~/.claude/.credentials.json`.
fn credentials_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR")
        && !dir.trim().is_empty()
    {
        return Some(PathBuf::from(dir).join(".credentials.json"));
    }
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

fn parse_credentials_token(raw: &str) -> Option<String> {
    serde_json::from_str::<ClaudeCredentialsFile>(raw)
        .ok()?
        .claude_ai_oauth?
        .access_token
        .filter(|t| !t.trim().is_empty())
}

/// Subscription access token written by `claude login`, if any.
pub fn credentials_file_token() -> Option<String> {
    let raw = std::fs::read_to_string(credentials_path()?).ok()?;
    parse_credentials_token(&raw)
}

/// CLI aliases. Always listed first: they track the latest model of each
/// family and are what existing workers store as their model.
const ALIASES: [(&str, &str); 5] = [
    ("opus", "Opus"),
    ("opus[1m]", "Opus (1M context)"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
];

/// Pinned models current as of 2026-10-01, only shown when live discovery
/// is unavailable.
const FALLBACK_PINNED: [(&str, &str); 4] = [
    ("claude-opus-5-5", "Opus 5.5"),
    ("claude-sonnet-5-5", "Sonnet 5.5"),
    ("claude-fable-5-1", "Fable 5.1"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5"),
];

fn model_info(id: String, name: String) -> ModelInfo {
    let reasoning_options = if supports_effort(&id) {
        effort_reasoning_options()
    } else {
        vec![]
    };
    ModelInfo {
        id,
        name,
        provider_id: None,
        reasoning_options,
    }
}

fn alias_models() -> Vec<ModelInfo> {
    ALIASES
        .into_iter()
        .map(|(id, name)| model_info(id.to_string(), name.to_string()))
        .collect()
}

/// Hardcoded fallback list, used when there is no subscription credential or
/// the Anthropic API is unreachable.
pub fn fallback_models() -> Vec<ModelInfo> {
    let mut models = alias_models();
    models.extend(
        FALLBACK_PINNED
            .into_iter()
            .map(|(id, name)| model_info(id.to_string(), name.to_string())),
    );
    models
}

pub fn effort_reasoning_options() -> Vec<ReasoningOption> {
    ReasoningOption::from_names(["low", "medium", "high", "xhigh", "max"].map(String::from))
}

fn supports_effort(id: &str) -> bool {
    let lowered = id.to_ascii_lowercase();
    lowered.contains("opus") || lowered.contains("sonnet")
}

fn display_for(id: &str, display_name: Option<&str>) -> String {
    let name = display_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    name.strip_prefix("Claude ").unwrap_or(name).to_string()
}

/// Fetch the models the Claude subscription (OAuth access token) can use from
/// the Anthropic API. The CLI aliases are listed first so `opus`, `opus[1m]`,
/// etc. stay selectable; the API does not surface them as models.
pub async fn fetch_anthropic_models(oauth_token: &str) -> Result<Vec<ModelInfo>, ModelsFetchError> {
    if oauth_token.trim().is_empty() {
        return Err(ModelsFetchError::MissingCredential);
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| ModelsFetchError::Http(e.to_string()))?;

    let request = client
        .get(ANTHROPIC_MODELS_URL)
        .bearer_auth(oauth_token)
        .header("anthropic-version", ANTHROPIC_API_VERSION)
        .header("anthropic-beta", ANTHROPIC_OAUTH_BETA)
        .query(&[("limit", PAGE_LIMIT.to_string())])
        .send();

    let resp = tokio::time::timeout(FETCH_TIMEOUT, request)
        .await
        .map_err(|_| ModelsFetchError::Timeout)?
        .map_err(|e| ModelsFetchError::Http(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let body: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(ModelsFetchError::Api {
            status: status.as_u16(),
            body,
        });
    }

    let parsed: AnthropicModelsResponse = resp
        .json()
        .await
        .map_err(|e| ModelsFetchError::Parse(e.to_string()))?;

    Ok(merge_with_aliases(parsed.data))
}

fn merge_with_aliases(data: Vec<AnthropicModel>) -> Vec<ModelInfo> {
    let mut models = alias_models();
    let mut seen: std::collections::HashSet<String> = models.iter().map(|m| m.id.clone()).collect();
    let mut discovered: Vec<ModelInfo> = data
        .into_iter()
        .filter(|m| !m.id.trim().is_empty())
        .filter(|m| seen.insert(m.id.clone()))
        .map(|m| {
            let name = display_for(&m.id, m.display_name.as_deref());
            model_info(m.id, name)
        })
        .collect();
    discovered.sort_by(|a, b| a.name.cmp(&b.name));
    models.extend(discovered);
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_includes_expected_aliases() {
        let ids: Vec<String> = fallback_models().into_iter().map(|m| m.id).collect();
        assert!(ids.contains(&"opus".to_string()));
        assert!(ids.contains(&"opus[1m]".to_string()));
        assert!(ids.contains(&"sonnet".to_string()));
        assert!(ids.contains(&"haiku".to_string()));
        assert!(ids.contains(&"fable".to_string()));
    }

    #[test]
    fn opus_and_sonnet_expose_effort_options() {
        for model in fallback_models() {
            let supports = supports_effort(&model.id);
            assert_eq!(
                supports,
                !model.reasoning_options.is_empty(),
                "{}",
                model.id
            );
        }
    }

    #[test]
    fn display_strips_claude_prefix() {
        assert_eq!(
            display_for("claude-opus-4-1", Some("Claude Opus 4.1")),
            "Opus 4.1"
        );
        assert_eq!(
            display_for("claude-haiku-4-5", Some("Claude Haiku 4.5")),
            "Haiku 4.5"
        );
        assert_eq!(display_for("claude-foo", None), "claude-foo");
        assert_eq!(display_for("claude-foo", Some("")), "claude-foo");
    }

    #[test]
    fn empty_token_returns_missing_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(fetch_anthropic_models("   ")).unwrap_err();
        assert!(matches!(err, ModelsFetchError::MissingCredential));
    }

    #[test]
    fn credentials_token_parsing() {
        assert_eq!(
            parse_credentials_token(r#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":1}}"#),
            Some("tok".to_string())
        );
        assert_eq!(
            parse_credentials_token(r#"{"claudeAiOauth":{"accessToken":" "}}"#),
            None
        );
        assert_eq!(parse_credentials_token("{}"), None);
        assert_eq!(parse_credentials_token("not json"), None);
    }

    #[test]
    fn discovered_models_keep_aliases_first_and_dedupe() {
        let data = vec![
            AnthropicModel {
                id: "claude-sonnet-5-5".into(),
                display_name: Some("Claude Sonnet 5.5".into()),
            },
            AnthropicModel {
                id: "claude-sonnet-5-5".into(),
                display_name: None,
            },
            AnthropicModel {
                id: "opus".into(),
                display_name: None,
            },
            AnthropicModel {
                id: " ".into(),
                display_name: None,
            },
        ];
        let ids: Vec<String> = merge_with_aliases(data).into_iter().map(|m| m.id).collect();
        assert_eq!(
            ids,
            [
                "opus",
                "opus[1m]",
                "sonnet",
                "haiku",
                "fable",
                "claude-sonnet-5-5"
            ]
        );
    }
}
