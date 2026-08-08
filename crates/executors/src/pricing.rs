//! Rust-side pricing table for LLM providers we invoke through the CLI
//! executors. Used to derive `cost_usd` at execution-process close time for
//! providers that do not report a dollar figure themselves (Codex, OpenCode).
//!
//! Claude Code emits its own `total_cost_usd` in the `result` message, which
//! is authoritative and skips this table. This table exists for the "we only
//! got token counts" path.
//!
//! Prices are USD per million tokens. Numbers taken from the public pricing
//! pages of each provider; keep them in sync when the pages change. Unknown
//! or unmatched models return `None` so the exit monitor persists tokens
//! without a cost instead of guessing.
//!
//! Matching is prefix-based on the model identifier, after stripping the
//! provider prefix (`anthropic/`, `openai/`, ...) and lowercasing. Entries
//! must be ordered longest-prefix-first so `claude-opus-4-1` beats the
//! shorter `claude-opus-4` line.
//!
//! Rounding: all arithmetic is `f64`, which is precise enough for tenths of
//! a cent — the numbers we care about here.

/// Per-million-token USD prices for a single model.
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    /// Anthropic-style prompt cache write price. `None` for providers without
    /// a distinct write tier — cache-creation tokens then fall back to the
    /// regular input price.
    pub cache_write_per_million: Option<f64>,
    /// Anthropic-style prompt cache read price. `None` for providers without
    /// a distinct read tier — cache-read tokens then fall back to the
    /// regular input price.
    pub cache_read_per_million: Option<f64>,
}

/// Token counts extracted from a `TokenUsageInfo` at persistence time.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageTokens {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
}

impl UsageTokens {
    pub fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_creation_tokens == 0
            && self.cache_read_tokens == 0
    }
}

/// Look up pricing for a model identifier. Returns `None` when the model
/// is not in the table; the caller should then persist tokens without a
/// cost rather than guess at a price.
pub fn lookup_pricing(model: &str) -> Option<ModelPricing> {
    let normalized = normalize_model_id(model);
    for (prefix, pricing) in MODEL_PRICING {
        if normalized.starts_with(prefix) {
            return Some(*pricing);
        }
    }
    None
}

/// Estimate the total USD cost of a call given a model and its token
/// breakdown. Returns `None` when the model is unknown so callers can tell
/// "no cost recorded" from "\$0.00".
pub fn estimate_cost_usd(model: &str, usage: &UsageTokens) -> Option<f64> {
    let pricing = lookup_pricing(model)?;
    let mut total = 0.0;
    total += (usage.input_tokens as f64) * pricing.input_per_million / 1_000_000.0;
    total += (usage.output_tokens as f64) * pricing.output_per_million / 1_000_000.0;
    let cache_write_price = pricing
        .cache_write_per_million
        .unwrap_or(pricing.input_per_million);
    total += (usage.cache_creation_tokens as f64) * cache_write_price / 1_000_000.0;
    let cache_read_price = pricing
        .cache_read_per_million
        .unwrap_or(pricing.input_per_million);
    total += (usage.cache_read_tokens as f64) * cache_read_price / 1_000_000.0;
    Some(total)
}

fn normalize_model_id(model: &str) -> String {
    // Strip provider prefix ("anthropic/claude-...", "openai/gpt-...") and
    // any tag suffix ("...:latest").
    let after_slash = model.rsplit('/').next().unwrap_or(model);
    let before_colon = after_slash.split(':').next().unwrap_or(after_slash);
    before_colon.to_ascii_lowercase()
}

// Order matters — longest, most specific prefix first so version-suffixed
// aliases (e.g. `claude-opus-4-1`) win over their base name.
const MODEL_PRICING: &[(&str, ModelPricing)] = &[
    // ------- Anthropic Claude -------
    // https://www.anthropic.com/pricing
    (
        "claude-opus-4-1",
        ModelPricing {
            input_per_million: 15.0,
            output_per_million: 75.0,
            cache_write_per_million: Some(18.75),
            cache_read_per_million: Some(1.50),
        },
    ),
    (
        "claude-opus-4",
        ModelPricing {
            input_per_million: 15.0,
            output_per_million: 75.0,
            cache_write_per_million: Some(18.75),
            cache_read_per_million: Some(1.50),
        },
    ),
    (
        "claude-sonnet-4-5",
        ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
            cache_write_per_million: Some(3.75),
            cache_read_per_million: Some(0.30),
        },
    ),
    (
        "claude-sonnet-4",
        ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
            cache_write_per_million: Some(3.75),
            cache_read_per_million: Some(0.30),
        },
    ),
    (
        "claude-haiku-4-5",
        ModelPricing {
            input_per_million: 1.0,
            output_per_million: 5.0,
            cache_write_per_million: Some(1.25),
            cache_read_per_million: Some(0.10),
        },
    ),
    (
        "claude-3-7-sonnet",
        ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
            cache_write_per_million: Some(3.75),
            cache_read_per_million: Some(0.30),
        },
    ),
    (
        "claude-3-5-sonnet",
        ModelPricing {
            input_per_million: 3.0,
            output_per_million: 15.0,
            cache_write_per_million: Some(3.75),
            cache_read_per_million: Some(0.30),
        },
    ),
    (
        "claude-3-5-haiku",
        ModelPricing {
            input_per_million: 0.80,
            output_per_million: 4.0,
            cache_write_per_million: Some(1.0),
            cache_read_per_million: Some(0.08),
        },
    ),
    (
        "claude-3-opus",
        ModelPricing {
            input_per_million: 15.0,
            output_per_million: 75.0,
            cache_write_per_million: Some(18.75),
            cache_read_per_million: Some(1.50),
        },
    ),
    (
        "claude-3-haiku",
        ModelPricing {
            input_per_million: 0.25,
            output_per_million: 1.25,
            cache_write_per_million: Some(0.30),
            cache_read_per_million: Some(0.03),
        },
    ),
    // ------- OpenAI (Codex, gpt-4x) -------
    // https://openai.com/api/pricing/
    (
        "gpt-5-codex",
        ModelPricing {
            input_per_million: 1.25,
            output_per_million: 10.0,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.125),
        },
    ),
    (
        "gpt-5-mini",
        ModelPricing {
            input_per_million: 0.25,
            output_per_million: 2.0,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.025),
        },
    ),
    (
        "gpt-5-nano",
        ModelPricing {
            input_per_million: 0.05,
            output_per_million: 0.40,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.005),
        },
    ),
    (
        "gpt-5",
        ModelPricing {
            input_per_million: 1.25,
            output_per_million: 10.0,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.125),
        },
    ),
    (
        "gpt-4o-mini",
        ModelPricing {
            input_per_million: 0.15,
            output_per_million: 0.60,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.075),
        },
    ),
    (
        "gpt-4o",
        ModelPricing {
            input_per_million: 2.50,
            output_per_million: 10.0,
            cache_write_per_million: None,
            cache_read_per_million: Some(1.25),
        },
    ),
    (
        "o4-mini",
        ModelPricing {
            input_per_million: 1.10,
            output_per_million: 4.40,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.275),
        },
    ),
    (
        "o3-mini",
        ModelPricing {
            input_per_million: 1.10,
            output_per_million: 4.40,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.55),
        },
    ),
    (
        "o3",
        ModelPricing {
            input_per_million: 2.0,
            output_per_million: 8.0,
            cache_write_per_million: None,
            cache_read_per_million: Some(0.50),
        },
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_prefixed_ids() {
        assert_eq!(
            normalize_model_id("anthropic/claude-sonnet-4-5-20250929"),
            "claude-sonnet-4-5-20250929"
        );
        assert_eq!(
            normalize_model_id("openai/gpt-5-codex:latest"),
            "gpt-5-codex"
        );
        assert_eq!(normalize_model_id("CLAUDE-OPUS-4-1"), "claude-opus-4-1");
    }

    #[test]
    fn looks_up_versioned_models() {
        assert!(lookup_pricing("claude-sonnet-4-5-20250929").is_some());
        assert!(lookup_pricing("anthropic/claude-opus-4-1-latest").is_some());
        assert!(lookup_pricing("openai/gpt-5-codex").is_some());
        assert!(lookup_pricing("gpt-4o-mini-2024-07-18").is_some());
    }

    #[test]
    fn unknown_models_return_none() {
        assert!(lookup_pricing("weird-experimental-model").is_none());
        assert!(estimate_cost_usd("no-such-model", &UsageTokens::default()).is_none());
    }

    #[test]
    fn longest_prefix_wins_over_shorter_family() {
        // If both "claude-opus-4" and "claude-opus-4-1" exist, the 4-1 line
        // must be picked for "claude-opus-4-1-20260101".
        let opus_4_1 = lookup_pricing("claude-opus-4-1-20260101").unwrap();
        let opus_4 = lookup_pricing("claude-opus-4-20260101").unwrap();
        // Both are Opus family — same numbers today, but the point is that
        // both matched a real entry.
        assert_eq!(opus_4_1.output_per_million, 75.0);
        assert_eq!(opus_4.output_per_million, 75.0);
    }

    #[test]
    fn estimates_include_cache_tiers() {
        let cost = estimate_cost_usd(
            "claude-sonnet-4-5",
            &UsageTokens {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                cache_creation_tokens: 1_000_000,
                cache_read_tokens: 1_000_000,
            },
        )
        .unwrap();
        // 3 + 15 + 3.75 + 0.30
        assert!((cost - 22.05).abs() < 1e-6);
    }

    #[test]
    fn falls_back_to_input_price_when_cache_tier_missing() {
        // Codex has cache_read but no distinct cache_write tier: creation
        // tokens are billed at the input price.
        let cost = estimate_cost_usd(
            "gpt-5-codex",
            &UsageTokens {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: 1_000_000,
                cache_read_tokens: 0,
            },
        )
        .unwrap();
        assert!((cost - 1.25).abs() < 1e-6);
    }
}
