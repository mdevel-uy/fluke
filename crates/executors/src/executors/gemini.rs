use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

pub use super::acp::AcpAgentHarness;
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SpawnedChild,
        StandardCodingAgentExecutor,
    },
    logs::utils::patch,
    model_selector::{ModelInfo, ModelSelectorConfig, PermissionPolicy},
    profile::ExecutorConfig,
};

const SUPPRESSED_STDERR_PATTERNS: &[&str] = &[
    "was started but never ended. Skipping metrics.",
    "YOLO mode is enabled. All tool calls will be automatically approved.",
];

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Gemini {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Gemini {
    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new("npx -y @google/gemini-cli@0.29.3");

        if let Some(model) = &self.model {
            builder = builder.extend_params(["--model", model.as_str()]);
        }

        if self.yolo.unwrap_or(false) {
            builder = builder.extend_params(["--yolo"]);
            builder = builder.extend_params(["--allowed-tools", "run_shell_command"]);
        }

        builder = builder.extend_params(["--experimental-acp"]);

        apply_overrides(builder, &self.cmd)
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Gemini {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            self.yolo = Some(matches!(
                permission_policy,
                crate::model_selector::PermissionPolicy::Auto
            ));
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let harness = AcpAgentHarness::new();
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let gemini_command = self.build_command_builder()?.build_initial()?;
        let approvals = if self.yolo.unwrap_or(false) {
            None
        } else {
            self.approvals.clone()
        };
        harness
            .spawn_with_command(
                current_dir,
                combined_prompt,
                gemini_command,
                env,
                &self.cmd,
                approvals,
            )
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let harness = AcpAgentHarness::new();
        let combined_prompt = self.append_prompt.combine_prompt(prompt);
        let gemini_command = self.build_command_builder()?.build_follow_up(&[])?;
        let approvals = if self.yolo.unwrap_or(false) {
            None
        } else {
            self.approvals.clone()
        };
        harness
            .spawn_follow_up_with_command(
                current_dir,
                combined_prompt,
                session_id,
                gemini_command,
                env,
                &self.cmd,
                approvals,
            )
            .await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        super::acp::normalize_logs_with_suppressed_stderr_patterns(
            msg_store,
            worktree_path,
            SUPPRESSED_STDERR_PATTERNS,
        )
    }

    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|home| home.join(".gemini").join("settings.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = dirs::home_dir()
            .and_then(|home| std::fs::metadata(home.join(".gemini").join("oauth_creds.json")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let mcp_config_found = self
            .default_mcp_config_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        let installation_indicator_found = dirs::home_dir()
            .map(|home| home.join(".gemini").join("installation_id").exists())
            .unwrap_or(false);

        if mcp_config_found || installation_indicator_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        use crate::model_selector::*;
        ExecutorConfig {
            executor: BaseCodingAgent::Gemini,
            variant: None,
            model_id: self.model.clone(),
            agent_id: None,
            reasoning_id: None,
            permission_policy: Some(if self.yolo.unwrap_or(false) {
                PermissionPolicy::Auto
            } else {
                PermissionPolicy::Supervised
            }),
        }
    }

    async fn discover_options(
        &self,
        _workdir: Option<&std::path::Path>,
        _repo_path: Option<&std::path::Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        use futures::StreamExt;

        use crate::{
            executor_discovery::ExecutorConfigCacheKey, executors::utils::executor_options_cache,
        };

        // The model list depends only on credentials, not on the workdir, so a
        // single global cache entry per command config is enough.
        let cache_key = ExecutorConfigCacheKey::new(
            None,
            serde_json::to_string(&self.cmd).unwrap_or_default(),
            BaseCodingAgent::Gemini,
        );
        if let Some(cached) = executor_options_cache().get(&cache_key) {
            return Ok(Box::pin(futures::stream::once(async move {
                patch::executor_discovered_options(cached.as_ref().clone().with_loading(false))
            })));
        }

        let mut initial = default_discovered_options();
        initial.loading_models = true;
        let initial_patch = patch::executor_discovered_options(initial);

        let api_key = self.resolve_api_key();
        let discovery = async_stream::stream! {
            let Some(key) = api_key else {
                // No key: the CLI is probably on OAuth / Vertex ADC. Keep the
                // built-in list without surfacing an error.
                yield patch::models_loaded();
                return;
            };
            match fetch_gemini_models(&key).await {
                Ok(models) => {
                    let mut opts = default_discovered_options();
                    opts.model_selector.models = models.clone();
                    executor_options_cache().put(cache_key, opts);
                    yield patch::update_models(models);
                    yield patch::models_loaded();
                }
                Err(e) => {
                    tracing::warn!("Failed to fetch Gemini models, using fallback: {e}");
                    yield patch::models_error(format!(
                        "Could not load Gemini models from Google ({e}). Using built-in list."
                    ));
                }
            }
        };

        Ok(Box::pin(
            futures::stream::once(async move { initial_patch }).chain(discovery),
        ))
    }
}

const GEMINI_MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl Gemini {
    /// Same env vars the Gemini CLI reads: profile env override first, then process env.
    fn resolve_api_key(&self) -> Option<String> {
        ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
            .iter()
            .find_map(|name| {
                self.cmd
                    .env
                    .as_ref()
                    .and_then(|env| env.get(*name).cloned())
                    .or_else(|| std::env::var(name).ok())
                    .filter(|k| !k.trim().is_empty())
            })
    }
}

/// Minimal list used when the Google API is unreachable or no key is configured.
fn fallback_models() -> Vec<ModelInfo> {
    [
        ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
        ("gemini-3-pro-preview", "Gemini 3 Pro"),
        ("gemini-3-flash-preview", "Gemini 3 Flash"),
    ]
    .into_iter()
    .map(|(id, name)| ModelInfo {
        id: id.to_string(),
        name: name.to_string(),
        provider_id: None,
        reasoning_options: vec![],
    })
    .collect()
}

fn default_discovered_options() -> ExecutorDiscoveredOptions {
    ExecutorDiscoveredOptions {
        model_selector: ModelSelectorConfig {
            models: fallback_models(),
            default_model: Some("gemini-3-pro-preview".to_string()),
            permissions: vec![PermissionPolicy::Auto, PermissionPolicy::Supervised],
            ..Default::default()
        },
        ..Default::default()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleModel {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

#[derive(Deserialize)]
struct GoogleModelsResponse {
    #[serde(default)]
    models: Vec<GoogleModel>,
}

/// Keep only text-generation Gemini models usable for coding: drops embeddings,
/// Gemma, and the TTS / image / audio / live variants.
fn to_model_info(m: GoogleModel) -> Option<ModelInfo> {
    let id = m.name.strip_prefix("models/").unwrap_or(&m.name);
    let excluded = ["embedding", "tts", "image", "audio", "live", "aqa"];
    if !id.starts_with("gemini-")
        || !m
            .supported_generation_methods
            .iter()
            .any(|g| g == "generateContent")
        || excluded.iter().any(|x| id.contains(x))
    {
        return None;
    }
    Some(ModelInfo {
        id: id.to_string(),
        name: m
            .display_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| id.to_string()),
        provider_id: None,
        reasoning_options: vec![],
    })
}

async fn fetch_gemini_models(api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(GEMINI_MODELS_URL)
        .header("x-goog-api-key", api_key)
        .query(&[("pageSize", "1000")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(format!("status {status}: {body}"));
    }
    let parsed: GoogleModelsResponse = resp.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<ModelInfo> = parsed
        .models
        .into_iter()
        .filter_map(to_model_info)
        .collect();
    if models.is_empty() {
        return Err("no Gemini generative models returned".to_string());
    }
    // Newest versions first (ids are versioned, e.g. gemini-3-pro > gemini-2.5-pro).
    models.sort_by(|a, b| b.id.cmp(&a.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keep(name: &str, methods: &[&str]) -> Option<String> {
        to_model_info(GoogleModel {
            name: name.to_string(),
            display_name: None,
            supported_generation_methods: methods.iter().map(|s| s.to_string()).collect(),
        })
        .map(|m| m.id)
    }

    #[test]
    fn filters_non_coding_models() {
        assert_eq!(
            keep("models/gemini-2.5-pro", &["generateContent"]).as_deref(),
            Some("gemini-2.5-pro")
        );
        assert!(keep("models/gemini-embedding-001", &["embedContent"]).is_none());
        assert!(keep("models/gemini-2.5-flash-preview-tts", &["generateContent"]).is_none());
        assert!(keep("models/gemini-2.5-flash-image", &["generateContent"]).is_none());
        assert!(keep("models/gemma-3-27b-it", &["generateContent"]).is_none());
    }
}
