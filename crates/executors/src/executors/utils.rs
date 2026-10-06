use std::{
    hash::Hash,
    num::NonZeroUsize,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use futures::StreamExt;
use lru::LruCache;

use super::{BaseCodingAgent, SlashCommandDescription, StandardCodingAgentExecutor};
use crate::{
    executor_discovery::{ExecutorConfigCacheKey, ExecutorDiscoveredOptions},
    profile::ExecutorConfigs,
};

/// The agent CLI to run: the user's installed `bin` when it is at least the
/// version of the `pinned` npx package (`npx -y pkg@X.Y.Z`), else the pinned
/// package. The installed CLI is the one that writes the shared config
/// (`~/.codex/config.toml`, …) and knows the account's newest models, so
/// following it avoids an old pinned CLI choking on a newer config; never
/// going below the pin keeps the version Fluke was built and tested against
/// as the floor.
///
/// Resolved once per process (one `--version` call).
/// ponytail: a CLI installed or upgraded while the server runs is picked up on restart.
pub fn installed_or_pinned(
    cache: &'static OnceLock<String>,
    bin: &str,
    pinned: &'static str,
) -> &'static str {
    cache.get_or_init(|| {
        let floor = pinned.rsplit('@').next().unwrap_or_default();
        match installed_version(bin) {
            Some(v) if version_at_least(&v, floor) => {
                tracing::info!("{bin}: using the installed CLI ({v}, pinned {floor})");
                bin.to_string()
            }
            found => {
                tracing::info!(
                    "{bin}: using the pinned CLI {floor} (installed: {})",
                    found.as_deref().unwrap_or("none")
                );
                pinned.to_string()
            }
        }
    })
}

fn installed_version(bin: &str) -> Option<String> {
    use workspace_utils::command_ext::NoWindowExt;
    let path = workspace_utils::shell::resolve_executable_path_blocking(bin)?;
    let out = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .no_window()
        .output()
        .ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout)).map(str::to_string)
}

/// First `X.Y.Z` token: "codex-cli 0.158.0" → "0.158.0",
/// "2.1.220 (Claude Code)" → "2.1.220".
fn parse_version(text: &str) -> Option<&str> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')')
        .find(|t| t.split('.').count() == 3 && t.split('.').all(|p| p.parse::<u64>().is_ok()))
}

fn version_at_least(version: &str, floor: &str) -> bool {
    let nums = |v: &str| -> Option<Vec<u64>> { v.split('.').map(|p| p.parse().ok()).collect() };
    match (nums(version), nums(floor)) {
        (Some(v), Some(f)) => v >= f,
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommandCall<'a> {
    /// The command name in lowercase (without the leading slash)
    pub name: String,
    /// The arguments after the command name
    pub arguments: &'a str,
}

pub fn parse_slash_command<'a, T>(prompt: &'a str) -> Option<T>
where
    T: From<SlashCommandCall<'a>>,
{
    let trimmed = prompt.trim_start();
    let without_slash = trimmed.strip_prefix('/')?;
    let mut parts = without_slash.splitn(2, |ch: char| ch.is_whitespace());
    let name = parts.next()?.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    let arguments = parts.next().map(|s| s.trim()).unwrap_or("");
    Some(T::from(SlashCommandCall { name, arguments }))
}

/// Reorder slash commands to prioritize compact then review.
#[must_use]
pub fn reorder_slash_commands(
    commands: impl IntoIterator<Item = SlashCommandDescription>,
) -> Vec<SlashCommandDescription> {
    let mut compact_command = None;
    let mut review_commands = None;
    let mut remaining_commands = Vec::new();

    for command in commands {
        match command.name.as_str() {
            "compact" => compact_command = Some(command),
            "review" => review_commands = Some(command),
            _ => remaining_commands.push(command),
        }
    }

    compact_command
        .into_iter()
        .chain(review_commands)
        .chain(remaining_commands)
        .collect()
}

#[derive(Clone, Debug)]
struct CacheEntry<V> {
    cached_at: Instant,
    value: Arc<V>,
}

pub struct TtlCache<K, V> {
    cache: Mutex<LruCache<K, CacheEntry<V>>>,
    ttl: Duration,
}

impl<K, V> TtlCache<K, V>
where
    K: Hash + Eq,
{
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(capacity).unwrap_or_else(|| NonZeroUsize::new(1).unwrap()),
            )),
            ttl,
        }
    }

    #[must_use]
    pub fn get(&self, key: &K) -> Option<Arc<V>> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get(key)?;
        let value = entry.value.clone();
        let expired = entry.cached_at.elapsed() > self.ttl;
        if expired {
            cache.pop(key);
            None
        } else {
            Some(value)
        }
    }

    pub fn put(&self, key: K, value: V) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(
            key,
            CacheEntry {
                cached_at: Instant::now(),
                value: Arc::new(value),
            },
        );
    }
}

pub const EXECUTOR_OPTIONS_CACHE_CAPACITY: usize = 64;
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_mins(5);

pub fn executor_options_cache()
-> &'static TtlCache<ExecutorConfigCacheKey, ExecutorDiscoveredOptions> {
    static INSTANCE: OnceLock<TtlCache<ExecutorConfigCacheKey, ExecutorDiscoveredOptions>> =
        OnceLock::new();
    INSTANCE.get_or_init(|| TtlCache::new(EXECUTOR_OPTIONS_CACHE_CAPACITY, DEFAULT_CACHE_TTL))
}

/// Spawn a background task to refresh the global cache for an executor.
/// This should be called on every use to keep the cache warm.
pub fn spawn_global_cache_refresh_for_agent(base_agent: BaseCodingAgent) {
    spawn_global_cache_refresh_for_agent_with_configs(base_agent, ExecutorConfigs::get_cached());
}

fn spawn_global_cache_refresh_for_agent_with_configs(
    base_agent: BaseCodingAgent,
    configs: ExecutorConfigs,
) {
    let profile_id = crate::profile::ExecutorProfileId::new(base_agent);

    if let Some(coding_agent) = configs.get_coding_agent(&profile_id) {
        tokio::spawn(async move {
            if let Ok(mut stream) = coding_agent.discover_options(None, None).await {
                while stream.next().await.is_some() {}
            }
        });
    }
}

/// Preload the global cache for all executors with DEFAULT presets.
/// This should be called on startup to warm the cache.
pub async fn preload_global_executor_options_cache() {
    let configs = ExecutorConfigs::get_cached();
    let executors: Vec<BaseCodingAgent> = configs.executors.keys().copied().collect();

    for base_agent in executors {
        spawn_global_cache_refresh_for_agent_with_configs(base_agent, configs.clone());
    }
}

#[cfg(test)]
mod cli_version_tests {
    use super::{parse_version, version_at_least};

    #[test]
    fn parses_cli_version_output() {
        assert_eq!(parse_version("codex-cli 0.158.0\n"), Some("0.158.0"));
        assert_eq!(parse_version("2.1.220 (Claude Code)\n"), Some("2.1.220"));
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(version_at_least("0.158.0", "0.124.0"));
        assert!(version_at_least("0.124.0", "0.124.0"));
        assert!(!version_at_least("2.1.220", "2.1.280"));
        assert!(version_at_least("2.10.0", "2.9.9"));
        assert!(!version_at_least("garbage", "0.1.0"));
    }
}
