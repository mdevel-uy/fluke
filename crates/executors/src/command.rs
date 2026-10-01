use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;
use workspace_utils::shell::resolve_executable_path;

use crate::executors::ExecutorError;

#[derive(Debug, Error)]
pub enum CommandBuildError {
    #[error("base command cannot be parsed: {0}")]
    InvalidBase(String),
    #[error("base command is empty after parsing")]
    EmptyCommand,
    #[error("failed to quote command: {0}")]
    QuoteError(#[from] shlex::QuoteError),
    #[error("invalid shell parameters: {0}")]
    InvalidShellParams(String),
}

#[derive(Debug, Clone)]
pub struct CommandParts {
    program: String,
    args: Vec<String>,
}

impl CommandParts {
    pub fn new(program: String, args: Vec<String>) -> Self {
        Self { program, args }
    }

    pub async fn into_resolved(self) -> Result<(PathBuf, Vec<String>), ExecutorError> {
        let CommandParts { program, args } = self;
        if program == "npx"
            && let Some(cache) = npm_cache_dir()
            && let Some((bin, rest)) = npx_cached_bin(&cache, &args)
        {
            if !is_node_script(&bin) {
                return Ok((bin, rest));
            }
            if let Some(node) = resolve_executable_path("node").await {
                let mut node_args = vec![bin.to_string_lossy().into_owned()];
                node_args.extend(rest);
                return Ok((node, node_args));
            }
        }
        let executable = resolve_executable_path(&program)
            .await
            .ok_or(ExecutorError::ExecutableNotFound { program })?;
        Ok((executable, args))
    }
}

fn npm_cache_dir() -> Option<PathBuf> {
    if let Some(dir) =
        std::env::var_os("npm_config_cache").or_else(|| std::env::var_os("NPM_CONFIG_CACHE"))
    {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows) {
        dirs::data_local_dir().map(|d| d.join("npm-cache"))
    } else {
        dirs::home_dir().map(|h| h.join(".npm"))
    }
}

/// `npx -y pkg@x.y.z ...` keeps an npx node process (plus cmd shims on
/// Windows) alive for the whole agent run. When that exact version is already
/// in the npx cache, return its bin so it runs directly. Floating versions
/// (`@latest`) and cache misses return None and keep going through npx, which
/// also fills the cache for the next run.
fn npx_cached_bin(cache: &Path, args: &[String]) -> Option<(PathBuf, Vec<String>)> {
    let [flag, spec, rest @ ..] = args else {
        return None;
    };
    if flag != "-y" {
        return None;
    }
    let (name, version) = spec.rsplit_once('@').filter(|(n, _)| !n.is_empty())?;
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let short_name = name.rsplit('/').next().unwrap_or(name);
    for entry in std::fs::read_dir(cache.join("_npx")).ok()?.flatten() {
        let pkg_dir = entry.path().join("node_modules").join(name);
        let Ok(raw) = std::fs::read_to_string(pkg_dir.join("package.json")) else {
            continue;
        };
        let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if pkg["version"].as_str() != Some(version) {
            continue;
        }
        // Same pick as npx: the only bin, or the one named after the package.
        let bin = match &pkg["bin"] {
            serde_json::Value::String(s) => s.as_str(),
            serde_json::Value::Object(m) if m.len() == 1 => m.values().next()?.as_str()?,
            serde_json::Value::Object(m) => m.get(short_name)?.as_str()?,
            _ => return None,
        };
        let bin = pkg_dir.join(bin);
        return bin.is_file().then(|| (bin, rest.to_vec()));
    }
    None
}

fn is_node_script(bin: &Path) -> bool {
    matches!(
        bin.extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "cjs")
    ) || {
        use std::io::Read;
        let mut head = [0u8; 2];
        std::fs::File::open(bin)
            .and_then(|mut f| f.read_exact(&mut head))
            .is_ok()
            && &head == b"#!"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npx_cached_bin_only_for_cached_exact_versions() {
        let cache = std::env::temp_dir().join(format!("fluke-npx-test-{}", std::process::id()));
        let pkg = cache.join("_npx/abc/node_modules/@scope/tool");
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"version":"1.2.3","bin":{"tool":"bin/tool.exe"}}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("bin/tool.exe"), b"MZ").unwrap();
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        let (bin, rest) =
            npx_cached_bin(&cache, &args(&["-y", "@scope/tool@1.2.3", "--x"])).unwrap();
        assert_eq!(bin, pkg.join("bin/tool.exe"));
        assert_eq!(rest, args(&["--x"]));
        assert!(!is_node_script(&bin));
        assert!(npx_cached_bin(&cache, &args(&["-y", "@scope/tool@1.2.4"])).is_none());
        assert!(npx_cached_bin(&cache, &args(&["-y", "@scope/tool@latest"])).is_none());
        assert!(npx_cached_bin(&cache, &args(&["@scope/tool@1.2.3"])).is_none());

        std::fs::write(pkg.join("bin/tool.exe"), b"#!/usr/bin/env node").unwrap();
        assert!(is_node_script(&pkg.join("bin/tool.exe")));
        std::fs::remove_dir_all(&cache).ok();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, Default)]
pub struct CmdOverrides {
    #[schemars(
        title = "Base Command Override",
        description = "Override the base command with a custom command"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_command_override: Option<String>,
    #[schemars(
        title = "Additional Parameters",
        description = "Additional parameters to append to the base command"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_params: Option<Vec<String>>,
    #[schemars(
        title = "Environment Variables",
        description = "Environment variables to set when running the executor"
    )]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema)]
pub struct CommandBuilder {
    /// Base executable command (e.g., "npx -y @anthropic-ai/claude-code@latest")
    pub base: String,
    /// Optional parameters to append to the base command
    pub params: Option<Vec<String>>,
}

impl CommandBuilder {
    pub fn new<S: Into<String>>(base: S) -> Self {
        Self {
            base: base.into(),
            params: None,
        }
    }

    pub fn params<I>(mut self, params: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        self.params = Some(params.into_iter().map(|p| p.into()).collect());
        self
    }

    pub fn override_base<S: Into<String>>(mut self, base: S) -> Self {
        self.base = base.into();
        self
    }

    fn extend_shell_params<I>(mut self, more: I) -> Result<Self, CommandBuildError>
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        let joined = more
            .into_iter()
            .map(|p| p.into())
            .collect::<Vec<String>>()
            .join(" ");

        if joined.trim().is_empty() {
            return Ok(self);
        }

        let extra: Vec<String> = split_command_line(&joined)
            .map_err(|err| CommandBuildError::InvalidShellParams(format!("{joined}: {err}")))?;

        match &mut self.params {
            Some(p) => p.extend(extra),
            None => self.params = Some(extra),
        }
        Ok(self)
    }

    pub fn extend_params<I>(mut self, more: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<String>,
    {
        let extra: Vec<String> = more.into_iter().map(|p| p.into()).collect();
        match &mut self.params {
            Some(p) => p.extend(extra),
            None => self.params = Some(extra),
        }
        self
    }

    pub fn build_initial(&self) -> Result<CommandParts, CommandBuildError> {
        self.build(&[])
    }

    pub fn build_follow_up(
        &self,
        additional_args: &[String],
    ) -> Result<CommandParts, CommandBuildError> {
        self.build(additional_args)
    }

    fn build(&self, additional_args: &[String]) -> Result<CommandParts, CommandBuildError> {
        let mut parts = vec![];
        let base_parts = split_command_line(&self.base)?;
        parts.extend(base_parts);
        if let Some(ref params) = self.params {
            parts.extend(params.clone());
        }
        parts.extend(additional_args.iter().cloned());

        if parts.is_empty() {
            return Err(CommandBuildError::EmptyCommand);
        }

        let program = parts.remove(0);
        Ok(CommandParts::new(program, parts))
    }
}

fn split_command_line(input: &str) -> Result<Vec<String>, CommandBuildError> {
    #[cfg(windows)]
    {
        let parts = winsplit::split(input);
        if parts.is_empty() {
            Err(CommandBuildError::EmptyCommand)
        } else {
            Ok(parts)
        }
    }

    #[cfg(not(windows))]
    {
        shlex::split(input).ok_or_else(|| CommandBuildError::InvalidBase(input.to_string()))
    }
}

pub fn apply_overrides(
    builder: CommandBuilder,
    overrides: &CmdOverrides,
) -> Result<CommandBuilder, CommandBuildError> {
    let builder = if let Some(ref base) = overrides.base_command_override {
        builder.override_base(base.clone())
    } else {
        builder
    };
    if let Some(ref extra) = overrides.additional_params {
        builder.extend_shell_params(extra.clone())
    } else {
        Ok(builder)
    }
}
