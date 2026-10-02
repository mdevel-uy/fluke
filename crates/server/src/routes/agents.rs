use std::{
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{Router, extract::State, response::Json as ResponseJson, routing::get};
use deployment::Deployment;
use executors::executors::BaseCodingAgent;
use serde::Serialize;
use ts_rs::TS;
use utils::{claude_credentials, response::ApiResponse};

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
fn meters_from_usage(payload: &serde_json::Value) -> Vec<ClaudeUsageMeter> {
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
            tracing::warn!("claude usage payload had no known windows: {payload}");
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
