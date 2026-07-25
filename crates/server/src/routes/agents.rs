use std::{
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use deployment::Deployment;
use executors::executors::BaseCodingAgent;
use serde::Serialize;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// One plan-usage window: session (5h), weekly across models, weekly Opus.
#[derive(Debug, Clone, Serialize, TS)]
pub struct ClaudeUsageMeter {
    /// `session`, `week_all` or `week_opus`.
    pub key: String,
    /// 0-100.
    pub used_percent: f32,
    /// RFC3339, when Claude reported a reset time.
    pub resets_at: Option<String>,
}

/// Account-level Claude plan limits. Global, not per worker.
#[derive(Debug, Clone, Serialize, TS)]
pub struct ClaudeUsageResponse {
    /// Human plan label derived from the stored credentials (e.g. "Max 20x").
    pub plan: Option<String>,
    pub meters: Vec<ClaudeUsageMeter>,
    /// Workers whose active workspace runs Claude Code.
    pub workers_on_claude: i64,
}

/// Same source as the CLI's `/usage` command. The stream-json
/// `rate_limit_event` looked promising but carries no utilization numbers
/// (only `status`/`rateLimitType`/`resetsAt`), so meters must come from here.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Limits change slowly and this hits Anthropic's API, so the answer is cached
/// for a little under the frontend's 60s polling interval.
const CACHE_TTL: Duration = Duration::from_secs(45);

/// Timestamped answer; the inner `Option` is "no usage available" (not logged
/// in, request failed), which is worth caching too.
type CachedUsage = Option<(Instant, Option<ClaudeUsageResponse>)>;

static USAGE_CACHE: LazyLock<Mutex<CachedUsage>> = LazyLock::new(|| Mutex::new(None));

fn cached() -> Option<Option<ClaudeUsageResponse>> {
    let guard = USAGE_CACHE.lock().unwrap();
    let (stamped, value) = guard.as_ref()?;
    (stamped.elapsed() < CACHE_TTL).then(|| value.clone())
}

/// `$CLAUDE_CONFIG_DIR/.credentials.json`, or `~/.claude/.credentials.json`.
fn claude_credentials_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR")
        && !dir.is_empty()
    {
        return Some(PathBuf::from(dir).join(".credentials.json"));
    }
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
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
    let access_token = oauth.get("accessToken")?.as_str()?.to_string();
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

/// Read the CLI's stored OAuth credentials: the credentials file, then (on
/// macOS dev machines, where the CLI keeps them in the Keychain) `security`.
async fn read_claude_credentials() -> Option<ClaudeCredentials> {
    if let Some(path) = claude_credentials_path()
        && let Ok(raw) = tokio::fs::read_to_string(&path).await
        && let Some(creds) = credentials_from_json(&raw)
    {
        return Some(creds);
    }

    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .await
            .ok()?;
        if output.status.success()
            && let Ok(raw) = String::from_utf8(output.stdout)
        {
            return credentials_from_json(raw.trim());
        }
    }

    #[allow(unreachable_code)]
    None
}

/// Map the usage payload's windows onto the dashboard meters.
///
/// Shape (recovered from the CLI, which builds its `/usage` screen from this
/// endpoint plus the `anthropic-ratelimit-unified-*` headers):
/// `{"five_hour":{"utilization":0.62,"resets_at":1785002400},"seven_day":{…},
/// "seven_day_opus":{…}}` — `utilization` is a 0-1 fraction and `resets_at`
/// epoch seconds, but both are accepted as percent / RFC3339 strings too.
fn meters_from_usage(payload: &serde_json::Value) -> Vec<ClaudeUsageMeter> {
    const WINDOWS: [(&str, &str); 3] = [
        ("five_hour", "session"),
        ("seven_day", "week_all"),
        ("seven_day_opus", "week_opus"),
    ];

    let mut meters = Vec::new();
    for (window_key, meter_key) in WINDOWS {
        let Some(window) = payload.get(window_key) else {
            continue;
        };
        let Some(utilization) = window.get("utilization").and_then(|v| v.as_f64()) else {
            continue;
        };
        // 0-1 fraction normally; tolerate a value that is already a percent.
        let used_percent = if utilization <= 1.0 {
            utilization * 100.0
        } else {
            utilization
        };
        meters.push(ClaudeUsageMeter {
            key: meter_key.to_string(),
            used_percent: used_percent.clamp(0.0, 100.0) as f32,
            resets_at: window.get("resets_at").and_then(reset_to_rfc3339),
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
        .map_err(|err| tracing::debug!("claude usage request failed: {err}"))
        .ok()?;
    if !response.status().is_success() {
        // Expired token and not-logged-in both land here; the CLI refreshes
        // the token on its own as workers run, so this heals by itself.
        tracing::debug!("claude usage returned {}", response.status());
        return None;
    }
    response.json().await.ok()
}

async fn get_claude_usage(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Option<ClaudeUsageResponse>>>, ApiError> {
    if let Some(hit) = cached() {
        return Ok(ResponseJson(ApiResponse::success(hit)));
    }

    let workers_on_claude: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT w.worker_id)
           FROM workspaces w
           JOIN sessions s ON s.workspace_id = w.id
           WHERE w.archived = FALSE
             AND w.worker_id IS NOT NULL
             AND s.executor = ?"#,
    )
    .bind(BaseCodingAgent::ClaudeCode.to_string())
    .fetch_one(&deployment.db().pool)
    .await
    .unwrap_or(0);

    let mut response = None;
    if let Some(creds) = read_claude_credentials().await
        && let Some(payload) = fetch_usage_payload(&creds.access_token).await
    {
        let meters = meters_from_usage(&payload);
        if meters.is_empty() {
            tracing::debug!("claude usage payload had no known windows: {payload}");
        } else {
            response = Some(ClaudeUsageResponse {
                plan: creds.plan,
                meters,
                workers_on_claude,
            });
        }
    }

    *USAGE_CACHE.lock().unwrap() = Some((Instant::now(), response.clone()));
    Ok(ResponseJson(ApiResponse::success(response)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/agents/claude/usage", get(get_claude_usage))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn meters_from_the_documented_payload() {
        let payload = json!({
            "five_hour": { "utilization": 0.62, "resets_at": 1785002400 },
            "seven_day": { "utilization": 0.41, "resets_at": 1785412800 },
            "seven_day_opus": { "utilization": 0.78, "resets_at": 1785412800 },
            "seven_day_sonnet": { "utilization": 0.10, "resets_at": 1785412800 },
        });
        let meters = meters_from_usage(&payload);
        let keys: Vec<_> = meters.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["session", "week_all", "week_opus"]);
        assert!((meters[0].used_percent - 62.0).abs() < 0.01);
        assert_eq!(
            meters[0].resets_at.as_deref(),
            Some("2026-07-25T18:00:00+00:00")
        );
    }

    #[test]
    fn meters_tolerate_percent_scale_and_missing_windows() {
        let payload = json!({
            "five_hour": { "utilization": 62.0 },
        });
        let meters = meters_from_usage(&payload);
        assert_eq!(meters.len(), 1);
        assert!((meters[0].used_percent - 62.0).abs() < 0.01);
        assert!(meters[0].resets_at.is_none());
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
