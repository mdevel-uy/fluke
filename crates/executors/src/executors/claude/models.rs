use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;

use crate::model_selector::{ModelInfo, ReasoningOption};

const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const PAGE_LIMIT: u32 = 1000;
const OPUS_1M_NAME: &str = "Opus 5.5 (1M context)";

#[derive(Debug, Error)]
pub enum ModelsFetchError {
    #[error("ANTHROPIC_API_KEY not available")]
    MissingApiKey,
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

/// Hardcoded fallback list, used when the Anthropic API is unreachable or the
/// user has no API key configured. Kept intentionally minimal so it always
/// matches aliases the Claude Code CLI accepts. The names state the model
/// each alias actually resolves to under the CLI pinned in `claude.rs`
/// (`base_command`) — update both together when bumping the CLI.
pub fn fallback_models() -> Vec<ModelInfo> {
    let effort_options = effort_reasoning_options();

    [
        ("opus", "Opus 5.5"),
        ("opus[1m]", OPUS_1M_NAME),
        ("sonnet", "Sonnet 5"),
        ("haiku", "Haiku 4.5"),
        ("fable", "Fable 5.1"),
    ]
    .into_iter()
    .map(|(id, name)| ModelInfo {
        id: id.to_string(),
        name: name.to_string(),
        provider_id: None,
        reasoning_options: if supports_effort(id) {
            effort_options.clone()
        } else {
            vec![]
        },
    })
    .collect()
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

/// Fetch the list of models from the Anthropic API. Includes the CLI-only
/// `opus[1m]` variant on success so users keep access to the 1M-context alias.
pub async fn fetch_anthropic_models(api_key: &str) -> Result<Vec<ModelInfo>, ModelsFetchError> {
    if api_key.trim().is_empty() {
        return Err(ModelsFetchError::MissingApiKey);
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| ModelsFetchError::Http(e.to_string()))?;

    let request = client
        .get(ANTHROPIC_MODELS_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_API_VERSION)
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

    let effort_options = effort_reasoning_options();

    let mut seen = std::collections::HashSet::new();
    let mut models: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .filter(|m| !m.id.trim().is_empty())
        .filter(|m| seen.insert(m.id.clone()))
        .map(|m| {
            let name = display_for(&m.id, m.display_name.as_deref());
            let reasoning_options = if supports_effort(&m.id) {
                effort_options.clone()
            } else {
                vec![]
            };
            ModelInfo {
                id: m.id,
                name,
                provider_id: None,
                reasoning_options,
            }
        })
        .collect();

    models.sort_by(|a, b| a.name.cmp(&b.name));

    // Claude Code CLI exposes an `opus[1m]` alias for the 1M-context Opus
    // variant. The Anthropic API does not surface it as its own model, so we
    // append it after the API-discovered list.
    if !models.iter().any(|m| m.id == "opus[1m]") {
        models.push(ModelInfo {
            id: "opus[1m]".to_string(),
            name: OPUS_1M_NAME.to_string(),
            provider_id: None,
            reasoning_options: effort_options,
        });
    }

    Ok(models)
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
    fn empty_api_key_returns_missing_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(fetch_anthropic_models("   ")).unwrap_err();
        assert!(matches!(err, ModelsFetchError::MissingApiKey));
    }
}
