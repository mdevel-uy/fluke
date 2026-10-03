use std::{
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use deployment::Deployment;
use executors::{
    executors::{AvailabilityInfo, BaseCodingAgent, StandardCodingAgentExecutor},
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::Serialize;
use tokio::process::Command;
use ts_rs::TS;
use utils::{
    claude_credentials, command_ext::NoWindowExt, response::ApiResponse,
    shell::resolve_executable_path,
};

use crate::{DeploymentImpl, error::ApiError};

/// One plan-usage window of a provider.
#[derive(Debug, Clone, Serialize, TS)]
pub struct UsageMeter {
    /// Claude: `session`, `week_all`, `week_opus`. Copilot: `premium`,
    /// `chat`, `completions`.
    pub key: String,
    /// 0-100.
    pub used_percent: f32,
    /// RFC3339, when the provider reported a reset time.
    pub resets_at: Option<String>,
    /// Absolute figures, for quotas counted in requests (Copilot).
    pub used: Option<f64>,
    pub limit: Option<f64>,
}

/// Plan limits of one provider with a login on this machine.
#[derive(Debug, Clone, Serialize, TS)]
pub struct ProviderUsage {
    pub agent: BaseCodingAgent,
    /// Human plan label (e.g. "Max 20x").
    pub plan: Option<String>,
    /// Empty when the provider does not publish its usage.
    pub meters: Vec<UsageMeter>,
    /// Coding agents running on this provider right now.
    pub running: i64,
    /// API-equivalent cost of the coding agents run on it, last 30 days.
    pub cost_30d: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ProvidersUsageResponse {
    pub providers: Vec<ProviderUsage>,
    /// Agents fluke supports that have no login here.
    pub without_login: Vec<BaseCodingAgent>,
}

/// Same source as the CLI's `/usage` command. The stream-json
/// `rate_limit_event` looked promising but carries no utilization numbers
/// (only `status`/`rateLimitType`/`resetsAt`), so meters must come from here.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Limits change slowly and this hits Anthropic's API, so the answer is cached
/// for a little under the frontend's 60s polling interval.
const CACHE_TTL: Duration = Duration::from_secs(45);

/// Plan and meters of one provider.
type Limits = (BaseCodingAgent, Option<String>, Vec<UsageMeter>);

/// Limits per provider, timestamped. Failed requests are cached too.
type CachedUsage = Option<(Instant, Vec<Limits>)>;

static USAGE_CACHE: LazyLock<Mutex<CachedUsage>> = LazyLock::new(|| Mutex::new(None));

fn cached() -> Option<Vec<Limits>> {
    let guard = USAGE_CACHE.lock().unwrap();
    let (stamped, value) = guard.as_ref()?;
    (stamped.elapsed() < CACHE_TTL).then(|| value.clone())
}

#[derive(Debug, Clone)]
struct ClaudeCredentials {
    access_token: String,
    plan: Option<String>,
}

/// Parse Claude Code's credentials JSON:
/// `{"claudeAiOauth":{"accessToken":..,"subscriptionType":..,"rateLimitTier":..}}`.
fn credentials_from_json(raw: &str) -> Option<ClaudeCredentials> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth").unwrap_or(&value);
    let access_token = claude_credentials::access_token_from_json(raw)?;
    let plan = plan_label(
        oauth.get("rateLimitTier").and_then(|v| v.as_str()),
        oauth.get("subscriptionType").and_then(|v| v.as_str()),
    );
    Some(ClaudeCredentials { access_token, plan })
}

/// "default_claude_max_20x" → "Max 20x"; falls back to the capitalized
/// subscription type ("max" → "Max").
fn plan_label(rate_limit_tier: Option<&str>, subscription_type: Option<&str>) -> Option<String> {
    if let Some(tier) = rate_limit_tier {
        let tier = tier.to_ascii_lowercase();
        if let Some(idx) = tier.find("max_") {
            let mult = tier[idx + 4..]
                .split(|c: char| !c.is_ascii_alphanumeric())
                .next()
                .unwrap_or("");
            if !mult.is_empty() {
                return Some(format!("Max {mult}"));
            }
        }
    }
    subscription_type.map(|s| {
        let mut chars = s.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    })
}

/// Read the CLI's stored OAuth credentials (credentials file or macOS
/// Keychain, see [`utils::claude_credentials::read_stored_credentials_json`]).
///
/// A missing credentials file is the most common reason the dashboard's Claude
/// limits card stays hidden, so say which source was missing instead of just
/// returning `None`: a deployment that authenticates Claude Code through
/// `CLAUDE_CODE_OAUTH_TOKEN` never writes this file, and that silence is
/// indistinguishable from a failed request.
async fn read_claude_credentials() -> Option<ClaudeCredentials> {
    if let Some(raw) = claude_credentials::read_stored_credentials_json().await {
        if let Some(creds) = credentials_from_json(&raw) {
            return Some(creds);
        }
        tracing::warn!(
            "stored claude credentials are not in the expected \
             {{\"claudeAiOauth\":{{\"accessToken\":..}}}} shape"
        );
        return None;
    }

    tracing::warn!(
        "no Claude credentials found at {}; the Claude limits card stays hidden \
         until `claude login` stores them there. CLAUDE_CODE_OAUTH_TOKEN is not \
         a substitute: those tokens lack the `user:profile` scope the usage API \
         requires",
        claude_credentials::claude_credentials_path().map_or_else(
            || "$HOME/.claude/.credentials.json (no home directory)".to_string(),
            |path| path.display().to_string()
        )
    );
    None
}

/// Percentage for a window, read from the payload's `limits` array.
///
/// `limits` states the scale in the field name, so it is the only unambiguous
/// source: `{"kind":"weekly_all","percent":15,"resets_at":..}`. The per-window
/// `utilization` cannot be read on its own — see [`meters_from_usage`].
fn percent_from_limits(payload: &serde_json::Value, limit_kind: &str) -> Option<f64> {
    payload
        .get("limits")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("kind").and_then(|v| v.as_str()) == Some(limit_kind))?
        .get("percent")?
        .as_f64()
}

/// Map the usage payload's windows onto the dashboard meters.
///
/// Shape, captured from a live response (the original was reverse-engineered
/// from the CLI bundle and got the scale wrong):
/// ```json
/// {"five_hour":{"utilization":13.0,"resets_at":"2026-07-26T05:30:00+00:00"},
///  "seven_day":{"utilization":15.0,..}, "seven_day_opus":null,
///  "limits":[{"kind":"session","percent":13,..},
///            {"kind":"weekly_all","percent":15,..}]}
/// ```
///
/// `utilization` is a **percent**, not a 0-1 fraction: the same response's
/// `limits[].percent` reads 13 for a `utilization` of 13.0. Scaling anything
/// `<= 1.0` by 100 — as this did — is therefore wrong precisely when usage is
/// under 1%, i.e. right after a window resets, turning 0.5% into 50%. Prefer
/// `limits[]`, whose field name pins the scale down, and fall back to
/// `utilization` read as a percent.
///
/// Windows the account does not have come back as `null` (`seven_day_opus`
/// above) and are skipped, so fewer than three meters is normal.
fn meters_from_usage(payload: &serde_json::Value) -> Vec<UsageMeter> {
    // window key, meter key, matching `limits[].kind`
    const WINDOWS: [(&str, &str, &str); 3] = [
        ("five_hour", "session", "session"),
        ("seven_day", "week_all", "weekly_all"),
        ("seven_day_opus", "week_opus", "weekly_opus"),
    ];

    let mut meters = Vec::new();
    for (window_key, meter_key, limit_kind) in WINDOWS {
        let Some(window) = payload.get(window_key) else {
            continue;
        };
        let Some(used_percent) = percent_from_limits(payload, limit_kind)
            .or_else(|| window.get("utilization").and_then(|v| v.as_f64()))
        else {
            continue;
        };
        meters.push(UsageMeter {
            key: meter_key.to_string(),
            used_percent: used_percent.clamp(0.0, 100.0) as f32,
            resets_at: window.get("resets_at").and_then(reset_to_rfc3339),
            used: None,
            limit: None,
        });
    }
    meters
}

/// Epoch seconds (or an already-formatted string) → RFC3339.
fn reset_to_rfc3339(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let epoch = value.as_f64()?;
    chrono::DateTime::from_timestamp(epoch as i64, 0).map(|dt| dt.to_rfc3339())
}

async fn fetch_usage_payload(access_token: &str) -> Option<serde_json::Value> {
    let client = reqwest::Client::new();
    let response = client
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| tracing::warn!("claude usage request failed: {err}"))
        .ok()?;

    let status = response.status();
    if !status.is_success() {
        // 401 heals on its own — the CLI refreshes the token as workers run.
        // 403 does not: it means the token lacks `user:profile`, which is what
        // a `claude setup-token` token looks like. Very different fixes, so
        // don't collapse them into one message.
        let hint = match status.as_u16() {
            401 => " (token expired; the CLI refreshes it as workers run)",
            403 => {
                " (token lacks the `user:profile` scope; `claude setup-token` \
                    tokens never have it — run `claude login` instead)"
            }
            _ => "",
        };
        let body = response.text().await.unwrap_or_default();
        tracing::warn!("claude usage returned {status}{hint}: {}", body.trim());
        return None;
    }
    response.json().await.ok()
}

/// Every provider with a login on this machine, with the plan limits the ones
/// that publish them report. Claude and Copilot do; the rest show no meters.
async fn get_providers_usage(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ProvidersUsageResponse>>, ApiError> {
    let running: Vec<(String, i64)> = sqlx::query_as(
        "SELECT s.executor, COUNT(*) FROM execution_processes ep
           JOIN sessions s ON s.id = ep.session_id
          WHERE ep.status = 'running' AND ep.run_reason = 'codingagent'
          GROUP BY s.executor",
    )
    .fetch_all(&deployment.db().pool)
    .await?;
    let cost_30d: Vec<(String, f64)> = sqlx::query_as(
        "SELECT s.executor, COALESCE(SUM(ep.cost_usd), 0.0) FROM execution_processes ep
           JOIN sessions s ON s.id = ep.session_id
          WHERE ep.cost_usd IS NOT NULL AND ep.started_at >= datetime('now', '-30 days')
          GROUP BY s.executor",
    )
    .fetch_all(&deployment.db().pool)
    .await?;

    let usage = match cached() {
        Some(hit) => hit,
        None => {
            let configs = ExecutorConfigs::get_cached();
            let mut agents: Vec<BaseCodingAgent> = configs.executors.keys().copied().collect();
            agents.sort_by_key(|a| a.to_string());
            let mut usage = Vec::new();
            for agent in agents {
                let available = configs
                    .get_coding_agent(&ExecutorProfileId::new(agent))
                    .map(|a| a.get_availability_info())
                    .unwrap_or(AvailabilityInfo::NotFound);
                if !matches!(available, AvailabilityInfo::LoginDetected { .. }) {
                    continue;
                }
                let (plan, meters) = match agent {
                    BaseCodingAgent::ClaudeCode => claude_usage().await,
                    BaseCodingAgent::Copilot => copilot_usage().await,
                    _ => (None, Vec::new()),
                };
                usage.push((agent, plan, meters));
            }
            // Providers that report limits first.
            usage.sort_by_key(|(_, _, meters)| meters.is_empty());
            *USAGE_CACHE.lock().unwrap() = Some((Instant::now(), usage.clone()));
            usage
        }
    };

    let logged: Vec<BaseCodingAgent> = usage.iter().map(|(a, _, _)| *a).collect();
    let mut without_login: Vec<BaseCodingAgent> = ExecutorConfigs::get_cached()
        .executors
        .keys()
        .filter(|a| !logged.contains(a))
        .copied()
        .collect();
    without_login.sort_by_key(|a| a.to_string());
    let providers = usage
        .into_iter()
        .map(|(agent, plan, meters)| ProviderUsage {
            running: running
                .iter()
                .find(|(e, _)| *e == agent.to_string())
                .map_or(0, |(_, n)| *n),
            cost_30d: cost_30d
                .iter()
                .find(|(e, _)| *e == agent.to_string())
                .map_or(0.0, |(_, c)| *c),
            agent,
            plan,
            meters,
        })
        .collect();
    Ok(ResponseJson(ApiResponse::success(ProvidersUsageResponse {
        providers,
        without_login,
    })))
}

/// Claude plan and meters, from the CLI's OAuth credentials.
async fn claude_usage() -> (Option<String>, Vec<UsageMeter>) {
    let Some(creds) = read_claude_credentials().await else {
        return (None, Vec::new());
    };
    let meters = match fetch_usage_payload(&creds.access_token).await {
        Some(payload) => {
            let meters = meters_from_usage(&payload);
            if meters.is_empty() {
                tracing::warn!("claude usage payload had no known windows: {payload}");
            }
            meters
        }
        None => Vec::new(),
    };
    (creds.plan, meters)
}

/// Copilot quotas, from the endpoint its own clients read, through `gh`.
async fn copilot_usage() -> (Option<String>, Vec<UsageMeter>) {
    let Some(gh) = resolve_executable_path("gh").await else {
        return (None, Vec::new());
    };
    let output = Command::new(&gh)
        .args(["api", "copilot_internal/user"])
        .stdin(Stdio::null())
        .no_window()
        .output()
        .await;
    match output {
        Ok(out) if out.status.success() => serde_json::from_slice(&out.stdout)
            .map(|payload| copilot_from_payload(&payload))
            .unwrap_or_default(),
        Ok(out) => {
            tracing::warn!(
                "copilot usage request failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            (None, Vec::new())
        }
        Err(err) => {
            tracing::warn!("copilot usage request failed: {err}");
            (None, Vec::new())
        }
    }
}

/// `{"access_type_sku":"free_limited_copilot","copilot_plan":"individual",
///   "quota_reset_date_utc":"2026-11-01T00:00:00.000Z",
///   "quota_snapshots":{"premium_interactions":{"entitlement":300,
///   "remaining":180,"percent_remaining":60.0,"unlimited":false},..}}`
fn copilot_from_payload(payload: &serde_json::Value) -> (Option<String>, Vec<UsageMeter>) {
    let sku = payload
        .get("access_type_sku")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let plan = if sku.contains("free") {
        Some("Free".to_string())
    } else {
        payload
            .get("copilot_plan")
            .and_then(|v| v.as_str())
            .map(|p| match p {
                "individual" => "Pro".to_string(),
                other => plan_label(None, Some(other)).unwrap_or_default(),
            })
    };
    let resets_at = payload
        .get("quota_reset_date_utc")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let mut meters = Vec::new();
    for (snapshot, key) in [
        ("premium_interactions", "premium"),
        ("chat", "chat"),
        ("completions", "completions"),
    ] {
        let Some(q) = payload.get("quota_snapshots").and_then(|s| s.get(snapshot)) else {
            continue;
        };
        let limit = q.get("entitlement").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if q.get("unlimited").and_then(|v| v.as_bool()) == Some(true) || limit <= 0.0 {
            continue;
        }
        let remaining = q.get("remaining").and_then(|v| v.as_f64()).unwrap_or(limit);
        meters.push(UsageMeter {
            key: key.to_string(),
            used_percent: ((limit - remaining) / limit * 100.0).clamp(0.0, 100.0) as f32,
            resets_at: resets_at.clone(),
            used: Some(limit - remaining),
            limit: Some(limit),
        });
    }
    (plan, meters)
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/agents/usage", get(get_providers_usage))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Trimmed from a real response, including the `null` windows the account
    /// does not have.
    fn live_payload() -> serde_json::Value {
        json!({
            "five_hour": { "utilization": 13.0, "resets_at": "2026-07-26T05:30:00+00:00" },
            "seven_day": { "utilization": 15.0, "resets_at": "2026-07-31T21:00:00+00:00" },
            "seven_day_opus": serde_json::Value::Null,
            "seven_day_sonnet": serde_json::Value::Null,
            "limits": [
                { "kind": "session", "percent": 13,
                  "resets_at": "2026-07-26T05:30:00+00:00" },
                { "kind": "weekly_all", "percent": 15,
                  "resets_at": "2026-07-31T21:00:00+00:00" },
                { "kind": "weekly_scoped", "percent": 7,
                  "scope": { "model": { "display_name": "Fable" } } },
            ],
        })
    }

    #[test]
    fn meters_from_the_live_payload() {
        let meters = meters_from_usage(&live_payload());
        // Two, not three: `seven_day_opus` is null for this account, and the
        // weekly window it does have is scoped to a model the card cannot
        // label yet, so it is deliberately left out.
        let keys: Vec<_> = meters.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["session", "week_all"]);
        assert!((meters[0].used_percent - 13.0).abs() < 0.01);
        assert!((meters[1].used_percent - 15.0).abs() < 0.01);
        assert_eq!(
            meters[0].resets_at.as_deref(),
            Some("2026-07-26T05:30:00+00:00")
        );
    }

    /// The regression this file existed to hide: `utilization` is a percent,
    /// so sub-1% usage — the state right after a window resets — must not be
    /// multiplied by 100. `limits[].percent` is what settles the scale.
    #[test]
    fn sub_one_percent_usage_is_not_scaled_to_tens_of_percent() {
        let payload = json!({
            "five_hour": { "utilization": 0.5, "resets_at": "2026-07-26T05:30:00+00:00" },
            "limits": [{ "kind": "session", "percent": 0.5 }],
        });
        let meters = meters_from_usage(&payload);
        assert_eq!(meters.len(), 1);
        assert!(
            (meters[0].used_percent - 0.5).abs() < 0.01,
            "0.5% must stay 0.5%, got {}",
            meters[0].used_percent
        );
    }

    /// Older responses carried no `limits` array; `utilization` alone is still
    /// read as a percent rather than guessed at.
    #[test]
    fn utilization_without_limits_is_read_as_a_percent() {
        let payload = json!({ "five_hour": { "utilization": 62.0 } });
        let meters = meters_from_usage(&payload);
        assert_eq!(meters.len(), 1);
        assert!((meters[0].used_percent - 62.0).abs() < 0.01);
        assert!(meters[0].resets_at.is_none());

        let low = json!({ "five_hour": { "utilization": 0.5 } });
        let meters = meters_from_usage(&low);
        assert!((meters[0].used_percent - 0.5).abs() < 0.01);
    }

    #[test]
    fn epoch_resets_are_still_accepted() {
        let payload = json!({ "five_hour": { "utilization": 62.0, "resets_at": 1785002400 } });
        let meters = meters_from_usage(&payload);
        assert_eq!(
            meters[0].resets_at.as_deref(),
            Some("2026-07-25T18:00:00+00:00")
        );
    }

    /// Trimmed from a live free-plan response: premium has no entitlement.
    #[test]
    fn copilot_quotas_from_the_live_payload() {
        let payload = json!({
            "access_type_sku": "free_limited_copilot",
            "copilot_plan": "individual",
            "quota_reset_date_utc": "2026-11-01T00:00:00.000Z",
            "quota_snapshots": {
                "chat": { "entitlement": 200, "remaining": 150, "percent_remaining": 75.0, "unlimited": false },
                "completions": { "entitlement": 2000, "remaining": 2000, "unlimited": false },
                "premium_interactions": { "entitlement": 0, "remaining": 0, "unlimited": false }
            }
        });
        let (plan, meters) = copilot_from_payload(&payload);
        assert_eq!(plan.as_deref(), Some("Free"));
        let keys: Vec<_> = meters.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["chat", "completions"]);
        assert!((meters[0].used_percent - 25.0).abs() < 0.01);
        assert_eq!(meters[0].used, Some(50.0));
        assert_eq!(meters[0].limit, Some(200.0));
    }

    #[test]
    fn empty_payload_yields_no_meters() {
        assert!(meters_from_usage(&json!({})).is_empty());
    }

    #[test]
    fn credentials_parse_and_plan_label() {
        let creds = credentials_from_json(
            r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r",
                "subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#,
        )
        .expect("credentials must parse");
        assert_eq!(creds.access_token, "tok");
        assert_eq!(creds.plan.as_deref(), Some("Max 20x"));

        assert_eq!(plan_label(None, Some("max")).as_deref(), Some("Max"));
        assert_eq!(
            plan_label(Some("default_claude_max_5x"), None).as_deref(),
            Some("Max 5x")
        );
        assert_eq!(plan_label(None, None), None);
    }
}
