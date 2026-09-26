use anyhow::Error;
use executors::{executors::BaseCodingAgent, profile::ExecutorProfileId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub use v9::{
    EditorConfig, EditorType, GitHubConfig, NotificationConfig, SendMessageShortcut, ShowcaseState,
    SoundFile, ThemeMode, UiLanguage,
};

use crate::services::config::versions::v9;

fn default_git_branch_prefix() -> String {
    // Solo aplica a installs nuevas: todo config.json v10 persiste el campo, y
    // la migración desde v9 copia el valor previo ("mk", "vk", ...).
    "fk".to_string()
}

fn default_pr_auto_description_enabled() -> bool {
    true
}

fn default_relay_enabled() -> bool {
    true
}

fn default_max_review_rounds() -> u32 {
    3
}

fn default_agent_concurrency_limit() -> u32 {
    0
}

/// Man-hours credited to a completed task that carries no per-task override.
/// Four hours anchors the "half a working day" narrative used in the pricing
/// conversation and matches the issue-353 default.
fn default_hours_saved_per_task() -> f64 {
    4.0
}

/// Working hours in a month used to translate hours saved into an FTE
/// equivalent. 160 = 8 h × 20 working days, the industry benchmark.
fn default_hours_per_fte_month() -> f64 {
    160.0
}

/// Fully-loaded hourly rate used to monetise the "hours saved" figure. The
/// number quoted to a CTO cannot depend on the browser the report was opened
/// in, so it lives here rather than in each viewer's `localStorage`.
fn default_hourly_rate() -> f64 {
    75.0
}

/// Currency the monetary figures are expressed in. ISO-4217 code, kept as a
/// free-form string to allow additions without a schema migration; the
/// frontend renders it through `Intl.NumberFormat`.
fn default_currency() -> String {
    "USD".to_string()
}

/// Fraction of the net savings we invoice (pricing v5: "pagás un porcentaje
/// de lo que ahorrás"). 0.10 = 10%, the closed pricing model; the rate is the
/// only negotiable lever, so it is configurable per installation.
fn default_savings_fee_rate() -> f64 {
    0.10
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Config {
    pub config_version: String,
    pub theme: ThemeMode,
    pub executor_profile: ExecutorProfileId,
    pub disclaimer_acknowledged: bool,
    pub onboarding_acknowledged: bool,
    #[serde(default)]
    pub remote_onboarding_acknowledged: bool,
    pub notifications: NotificationConfig,
    pub editor: EditorConfig,
    pub github: GitHubConfig,
    pub analytics_enabled: bool,
    pub workspace_dir: Option<String>,
    pub last_app_version: Option<String>,
    pub show_release_notes: bool,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default = "default_git_branch_prefix")]
    pub git_branch_prefix: String,
    #[serde(default)]
    pub showcases: ShowcaseState,
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default = "default_relay_enabled")]
    pub relay_enabled: bool,
    #[serde(default)]
    pub host_nickname: Option<String>,
    #[serde(default = "default_max_review_rounds")]
    pub max_review_rounds: u32,
    #[serde(default = "default_agent_concurrency_limit")]
    pub agent_concurrency_limit: u32,
    /// Installation-wide default for the man-hours the "value generated"
    /// panel credits to a completed task that carries no per-task override.
    /// Persisted server-side so every viewer sees the same authoritative
    /// figure — the number that anchors the pricing conversation must not
    /// diverge per browser.
    #[serde(default = "default_hours_saved_per_task")]
    pub default_hours_saved_per_task: f64,
    /// Installation-wide default for the working hours in a month used to
    /// translate hours saved into the FTE equivalent shown in the value
    /// generated panel.
    #[serde(default = "default_hours_per_fte_month")]
    pub default_hours_per_fte_month: f64,
    /// Installation-wide default hourly rate used to monetise the hours
    /// saved (pilot report, value-generated panel). Kept server-side so the
    /// pricing figure quoted to a CTO does not diverge per browser.
    #[serde(default = "default_hourly_rate")]
    pub default_hourly_rate: f64,
    /// Installation-wide ISO-4217 currency code paired with
    /// `default_hourly_rate`. Kept as a string so a new currency does not
    /// require a schema migration; frontends render it via `Intl.NumberFormat`.
    #[serde(default = "default_currency")]
    pub default_currency: String,
    /// Fraction (0..=1) of the net savings billed to the customer — the
    /// "10% of what you save" figure in the pricing model. Server-side for
    /// the same reason as the hourly rate: the fee quoted must not depend on
    /// which browser opened the report.
    #[serde(default = "default_savings_fee_rate")]
    pub default_savings_fee_rate: f64,
}

impl Config {
    fn from_v9_config(old_config: v9::Config) -> Self {
        Self {
            config_version: "v10".to_string(),
            theme: old_config.theme,
            executor_profile: old_config.executor_profile,
            disclaimer_acknowledged: old_config.disclaimer_acknowledged,
            onboarding_acknowledged: old_config.onboarding_acknowledged,
            remote_onboarding_acknowledged: old_config.remote_onboarding_acknowledged,
            notifications: old_config.notifications,
            editor: old_config.editor,
            github: old_config.github,
            analytics_enabled: old_config.analytics_enabled,
            workspace_dir: old_config.workspace_dir,
            last_app_version: old_config.last_app_version,
            show_release_notes: old_config.show_release_notes,
            language: old_config.language,
            git_branch_prefix: old_config.git_branch_prefix,
            showcases: old_config.showcases,
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            send_message_shortcut: old_config.send_message_shortcut,
            relay_enabled: old_config.relay_enabled,
            host_nickname: old_config.host_nickname,
            max_review_rounds: old_config.max_review_rounds,
            agent_concurrency_limit: old_config.agent_concurrency_limit,
            default_hours_saved_per_task: old_config.default_hours_saved_per_task,
            default_hours_per_fte_month: old_config.default_hours_per_fte_month,
            default_hourly_rate: default_hourly_rate(),
            default_currency: default_currency(),
            default_savings_fee_rate: default_savings_fee_rate(),
        }
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v9::Config::from(raw_config.to_string());
        Ok(Self::from_v9_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v10"
        {
            return config;
        }

        match Self::from_previous_version(&raw_config) {
            Ok(config) => {
                tracing::info!("Config upgraded to v10");
                config
            }
            Err(e) => {
                tracing::warn!("Config migration failed: {}, using default", e);
                Self::default()
            }
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            config_version: "v10".to_string(),
            theme: ThemeMode::System,
            executor_profile: ExecutorProfileId::new(BaseCodingAgent::ClaudeCode),
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            remote_onboarding_acknowledged: false,
            notifications: NotificationConfig::default(),
            editor: EditorConfig::default(),
            github: GitHubConfig::default(),
            analytics_enabled: true,
            workspace_dir: None,
            last_app_version: None,
            show_release_notes: false,
            language: UiLanguage::default(),
            git_branch_prefix: default_git_branch_prefix(),
            showcases: ShowcaseState::default(),
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            send_message_shortcut: SendMessageShortcut::default(),
            relay_enabled: true,
            host_nickname: None,
            max_review_rounds: default_max_review_rounds(),
            agent_concurrency_limit: default_agent_concurrency_limit(),
            default_hours_saved_per_task: default_hours_saved_per_task(),
            default_hours_per_fte_month: default_hours_per_fte_month(),
            default_hourly_rate: default_hourly_rate(),
            default_currency: default_currency(),
            default_savings_fee_rate: default_savings_fee_rate(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_uses_fk_prefix() {
        assert_eq!(Config::default().git_branch_prefix, "fk");
    }

    #[test]
    fn persisted_prefix_is_preserved() {
        let existing = Config {
            git_branch_prefix: "mk".to_string(),
            ..Config::default()
        };
        let raw = serde_json::to_string(&existing).unwrap();
        assert_eq!(Config::from(raw).git_branch_prefix, "mk");

        let v9_config = v9::Config {
            git_branch_prefix: "mk".to_string(),
            ..v9::Config::default()
        };
        let raw = serde_json::to_string(&v9_config).unwrap();
        assert_eq!(Config::from(raw).git_branch_prefix, "mk");
    }
}
