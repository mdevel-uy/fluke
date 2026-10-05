use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;

use crate::model_selector::{ModelInfo, ReasoningOption};

const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Models that accept the priority service tier; the executor exposes them
/// with a synthetic `-fast` suffix (see `resolve_model`).
const FAST_CAPABLE: &[&str] = &["gpt-5.5", "gpt-5.4"];

#[derive(Debug, Error)]
pub enum ModelsFetchError {
    #[error("OPENAI_API_KEY not available")]
    MissingApiKey,
    #[error("timed out fetching OpenAI models")]
    Timeout,
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("OpenAI API returned status {status}: {body}")]
    Api { status: u16, body: String },
    #[error("failed to parse OpenAI response: {0}")]
    Parse(String),
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

/// Hardcoded fallback list, used when the OpenAI API is unreachable or the
/// user authenticates through ChatGPT login (no API key).
pub fn fallback_models() -> Vec<ModelInfo> {
    with_fast_variants(
        [
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex",
            "gpt-5.3-codex-spark",
            "gpt-5.2",
        ]
        .map(String::from)
        .to_vec(),
    )
}

/// Reasoning efforts this build's Codex client can send (`ReasoningEffort`
/// in the pinned `codex-protocol`). A newer Codex may offer more (`max`,
/// `ultra`); they are left out of the picker until the protocol is bumped.
const CLIENT_REASONING_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];

/// The account's models as Codex itself lists them (`model/list` on its
/// app-server, the same request its own picker makes): the only source for a
/// ChatGPT login, and never stale. `program`/`args` start `codex app-server`.
///
/// The response is read as plain JSON, not the pinned protocol types, so a
/// newer Codex that adds fields or enum values still yields a list.
pub async fn fetch_app_server_models(
    program: std::path::PathBuf,
    args: Vec<String>,
) -> Result<Vec<ModelInfo>, ModelsFetchError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use workspace_utils::command_ext::NoWindowExt;

    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window()
        .spawn()
        .map_err(|e| ModelsFetchError::Http(format!("could not start codex app-server: {e}")))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();

    let messages = [
        serde_json::json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "fluke-codex-models", "title": null, "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {"experimentalApi": true}
        }}),
        serde_json::json!({"method": "initialized"}),
        serde_json::json!({"id": 2, "method": "model/list", "params": {}}),
    ];
    let exchange = async {
        for message in &messages {
            stdin.write_all(format!("{message}
").as_bytes()).await?;
        }
        stdin.flush().await?;
        while let Some(line) = lines.next_line().await? {
            let Ok(reply) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if reply.get("id").and_then(|id| id.as_i64()) == Some(2) {
                return Ok(reply);
            }
        }
        Err(std::io::Error::other("codex app-server closed before answering"))
    };
    let reply = tokio::time::timeout(APP_SERVER_TIMEOUT, exchange)
        .await
        .map_err(|_| ModelsFetchError::Timeout)?
        .map_err(|e| ModelsFetchError::Http(e.to_string()))?;
    if let Some(error) = reply.get("error") {
        return Err(ModelsFetchError::Api {
            status: 0,
            body: error.to_string(),
        });
    }
    models_from_list_reply(&reply).ok_or_else(|| ModelsFetchError::Parse(reply.to_string()))
}

/// First run through `npx` may download the pinned CLI.
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(60);

/// `{"result":{"data":[{model, displayName, hidden, supportedReasoningEfforts,
/// defaultReasoningEffort, isDefault}, …]}}` → picker models, default first.
fn models_from_list_reply(reply: &serde_json::Value) -> Option<Vec<ModelInfo>> {
    let data = reply.pointer("/result/data")?.as_array()?;
    let mut models: Vec<(bool, ModelInfo)> = data
        .iter()
        .filter(|m| !m.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false))
        .filter_map(|m| {
            let id = m.get("model")?.as_str()?.to_string();
            let name = m
                .get("displayName")
                .and_then(|n| n.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| display_for(&id));
            let default_effort = m.get("defaultReasoningEffort").and_then(|e| e.as_str());
            let mut reasoning_options = ReasoningOption::from_names(
                m.get("supportedReasoningEfforts")
                    .and_then(|e| e.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.get("reasoningEffort")?.as_str())
                    .filter(|e| CLIENT_REASONING_EFFORTS.contains(e))
                    .map(str::to_string),
            );
            for option in &mut reasoning_options {
                option.is_default = Some(option.id.as_str()) == default_effort;
            }
            let is_default = m.get("isDefault").and_then(|d| d.as_bool()).unwrap_or(false);
            Some((
                is_default,
                ModelInfo {
                    id,
                    name,
                    provider_id: None,
                    reasoning_options,
                },
            ))
        })
        .collect();
    models.sort_by_key(|(is_default, _)| !is_default);
    Some(models.into_iter().map(|(_, m)| m).collect())
}

/// Keep only coding models usable by Codex: GPT-5+, o-series and `codex-*`,
/// excluding audio/image/realtime/search variants, chat-tuned and `pro`
/// models, and dated snapshots.
fn is_coding_model(id: &str) -> bool {
    /// Matched as whole `-` segments (`gpt-5-chat-latest`, `o3-pro`).
    const EXCLUDED_SEGMENTS: &[&str] = &["chat", "pro"];
    const EXCLUDED: &[&str] = &[
        "audio",
        "realtime",
        "tts",
        "transcribe",
        "image",
        "search",
        "embedding",
        "moderation",
        "instruct",
        "deep-research",
    ];
    let id = id.to_ascii_lowercase();
    if EXCLUDED.iter().any(|w| id.contains(w))
        || id.split('-').any(|s| EXCLUDED_SEGMENTS.contains(&s))
        || is_dated_snapshot(&id)
    {
        return false;
    }
    if id.starts_with("codex-") {
        return true;
    }
    let gpt5_plus = id
        .strip_prefix("gpt-")
        .and_then(|rest| rest.split(['.', '-']).next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 5);
    let o_series = id
        .strip_prefix('o')
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_ascii_digit());
    gpt5_plus || o_series
}

/// `gpt-5-2025-08-07`, `o3-2025-04-16`: pinned snapshots duplicate their alias.
fn is_dated_snapshot(id: &str) -> bool {
    let tail: Vec<&str> = id.rsplitn(4, '-').take(3).collect();
    tail.len() == 3
        && tail[2].len() == 4
        && tail
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Reasoning efforts accepted by Codex for a given model. o-series tops out at
/// `high`; GPT-5 family also accepts `xhigh`. Everything we keep reasons.
fn reasoning_options_for(id: &str) -> Vec<ReasoningOption> {
    let mut names = vec!["low", "medium", "high"];
    if id.starts_with("gpt-") {
        names.push("xhigh");
    }
    ReasoningOption::from_names(names)
}

fn display_for(id: &str) -> String {
    let (base, fast) = match id.strip_suffix("-fast") {
        Some(base) => (base, true),
        None => (id, false),
    };
    let pretty = base
        .split('-')
        .map(|part| match part {
            "gpt" => "GPT".to_string(),
            p if p.starts_with('o') && p[1..].chars().all(|c| c.is_ascii_digit()) => p.to_string(),
            p => {
                let mut chars = p.chars();
                chars
                    .next()
                    .map(|c| c.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .replacen("GPT ", "GPT-", 1);
    if fast {
        format!("{pretty} Fast")
    } else {
        pretty
    }
}

fn to_model_info(id: String) -> ModelInfo {
    ModelInfo {
        name: display_for(&id),
        reasoning_options: reasoning_options_for(&id),
        provider_id: None,
        id,
    }
}

/// Insert a `-fast` variant right after each fast-capable model.
fn with_fast_variants(ids: Vec<String>) -> Vec<ModelInfo> {
    let mut out = Vec::with_capacity(ids.len() + FAST_CAPABLE.len());
    for id in ids {
        let fast = FAST_CAPABLE
            .contains(&id.as_str())
            .then(|| format!("{id}-fast"));
        out.push(to_model_info(id));
        if let Some(fast) = fast {
            out.push(to_model_info(fast));
        }
    }
    out
}

/// Fetch the model catalog from `GET {base_url}/models` and map it to the
/// executor's model list, newest-looking ids first.
pub async fn fetch_openai_models(
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<ModelInfo>, ModelsFetchError> {
    if api_key.trim().is_empty() {
        return Err(ModelsFetchError::MissingApiKey);
    }
    let base_url = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(OPENAI_DEFAULT_BASE_URL)
        .trim_end_matches('/');

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| ModelsFetchError::Http(e.to_string()))?;

    let request = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
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

    let parsed: OpenAiModelsResponse = resp
        .json()
        .await
        .map_err(|e| ModelsFetchError::Parse(e.to_string()))?;

    Ok(map_models(parsed.data.into_iter().map(|m| m.id)))
}

fn map_models(ids: impl IntoIterator<Item = String>) -> Vec<ModelInfo> {
    let mut ids: Vec<String> = ids.into_iter().filter(|id| is_coding_model(id)).collect();
    // GPT family first, then o-series; newest-looking ids first within each.
    // ponytail: lexical order, so a future gpt-5.10 sorts below gpt-5.9; parse
    // versions if that day comes.
    ids.sort_by(|a, b| {
        a.starts_with('o')
            .cmp(&b.starts_with('o'))
            .then_with(|| b.cmp(a))
    });
    ids.dedup();
    with_fast_variants(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_server_model_list_maps_to_picker_models() {
        // Trimmed from a real `model/list` reply of Codex 0.158 (fields and
        // effort values the pinned protocol doesn't know included).
        let reply = serde_json::json!({"id": 2, "result": {"data": [
            {"model": "gpt-5.5", "displayName": "GPT-5.5", "hidden": false, "isDefault": false,
             "defaultReasoningEffort": "medium", "serviceTiers": [],
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}]},
            {"model": "gpt-6-sol", "displayName": "GPT-6-Sol", "hidden": false, "isDefault": true,
             "defaultReasoningEffort": "medium",
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"},
                                           {"reasoningEffort": "xhigh"}, {"reasoningEffort": "ultra"}]},
            {"model": "internal", "displayName": "Hidden", "hidden": true, "isDefault": false,
             "supportedReasoningEfforts": []}
        ], "nextCursor": null}});
        let models = models_from_list_reply(&reply).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6-sol", "gpt-5.5"]);
        assert_eq!(models[0].name, "GPT-6-Sol");
        let efforts: Vec<&str> = models[0].reasoning_options.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(efforts, ["low", "medium", "xhigh"]);
        assert!(models[0].reasoning_options.iter().any(|r| r.id == "medium" && r.is_default));
    }

    #[test]
    fn filters_non_coding_models() {
        let ids = [
            "gpt-5.5",
            "gpt-5.4-mini",
            "gpt-5.3-codex",
            "o3",
            "o4-mini",
            "gpt-4o",
            "gpt-4.1",
            "gpt-5-2025-08-07",
            "o3-2025-04-16",
            "gpt-realtime",
            "gpt-4o-mini-tts",
            "text-embedding-3-large",
            "whisper-1",
            "dall-e-3",
            "gpt-image-1",
            "omni-moderation-latest",
            "o3-deep-research",
            "codex-mini-latest",
            "gpt-5-chat-latest",
            "gpt-5-pro",
            "o3-pro",
        ]
        .map(String::from);
        let got: Vec<String> = map_models(ids).into_iter().map(|m| m.id).collect();
        assert_eq!(
            got,
            [
                "gpt-5.5",
                "gpt-5.5-fast",
                "gpt-5.4-mini",
                "gpt-5.3-codex",
                "codex-mini-latest",
                "o4-mini",
                "o3"
            ]
        );
    }

    #[test]
    fn reasoning_options_by_family() {
        let ids = |m: &ModelInfo| -> Vec<String> {
            m.reasoning_options.iter().map(|r| r.id.clone()).collect()
        };
        let models = map_models(["gpt-5.4".to_string(), "o3".to_string()]);
        let gpt = models.iter().find(|m| m.id == "gpt-5.4").unwrap();
        let o3 = models.iter().find(|m| m.id == "o3").unwrap();
        assert_eq!(ids(gpt), ["low", "medium", "high", "xhigh"]);
        assert_eq!(ids(o3), ["low", "medium", "high"]);
        assert!(gpt.reasoning_options.iter().any(|r| r.is_default));
    }

    #[test]
    fn display_names() {
        assert_eq!(display_for("gpt-5.5"), "GPT-5.5");
        assert_eq!(display_for("gpt-5.5-fast"), "GPT-5.5 Fast");
        assert_eq!(display_for("gpt-5.4-mini"), "GPT-5.4 Mini");
        assert_eq!(display_for("gpt-5.3-codex-spark"), "GPT-5.3 Codex Spark");
        assert_eq!(display_for("o4-mini"), "o4 Mini");
    }

    #[test]
    fn fallback_keeps_fast_variants() {
        let ids: Vec<String> = fallback_models().into_iter().map(|m| m.id).collect();
        assert!(ids.contains(&"gpt-5.5-fast".to_string()));
        assert!(ids.contains(&"gpt-5.4-fast".to_string()));
        assert!(
            fallback_models()
                .iter()
                .all(|m| !m.reasoning_options.is_empty())
        );
    }

    #[test]
    fn empty_api_key_returns_missing_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(fetch_openai_models("  ", None)).unwrap_err();
        assert!(matches!(err, ModelsFetchError::MissingApiKey));
    }
}
