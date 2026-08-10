use std::{collections::HashMap, path::PathBuf};

use tokio::process::Command;

use crate::command::CmdOverrides;

/// Repository context for executor operations
#[derive(Debug, Clone, Default)]
pub struct RepoContext {
    pub workspace_root: PathBuf,
    /// Names of repositories in the workspace (subdirectory names)
    pub repo_names: Vec<String>,
}

impl RepoContext {
    pub fn new(workspace_root: PathBuf, repo_names: Vec<String>) -> Self {
        Self {
            workspace_root,
            repo_names,
        }
    }

    pub fn repo_paths(&self) -> Vec<PathBuf> {
        self.repo_names
            .iter()
            .map(|name| self.workspace_root.join(name))
            .collect()
    }
}

/// Environment variables to inject into executor processes
#[derive(Debug, Clone)]
pub struct ExecutionEnv {
    pub vars: HashMap<String, String>,
    pub repo_context: RepoContext,
}

impl ExecutionEnv {
    pub fn new(repo_context: RepoContext) -> Self {
        Self {
            vars: HashMap::new(),
            repo_context,
        }
    }

    /// Insert an environment variable
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.vars.insert(key.into(), value.into());
    }

    /// Merge additional vars into this env. Incoming keys overwrite existing ones.
    pub fn merge(&mut self, other: &HashMap<String, String>) {
        self.vars
            .extend(other.iter().map(|(k, v)| (k.clone(), v.clone())));
    }

    /// Return a new env with overrides applied. Overrides take precedence.
    pub fn with_overrides(mut self, overrides: &HashMap<String, String>) -> Self {
        self.merge(overrides);
        self
    }

    /// Return a new env with profile env from CmdOverrides merged in.
    pub fn with_profile(self, cmd: &CmdOverrides) -> Self {
        if let Some(ref profile_env) = cmd.env {
            self.with_overrides(profile_env)
        } else {
            self
        }
    }

    /// Apply all environment variables to a Command.
    ///
    /// Before applying the map, GitHub credential envs (`GH_TOKEN` and
    /// `GITHUB_TOKEN`) are unconditionally removed so the child never inherits
    /// them from the server process. The agent produces content; the system
    /// produces effects — GitHub writes are drained by the server using each
    /// worker's PAT, so an agent process has no reason to hold the token in
    /// its env. Callers that do put these keys into `self.vars` will still
    /// win, because `command.env` runs after `env_remove` here.
    pub fn apply_to_command(&self, command: &mut Command) {
        command.env_remove("GH_TOKEN");
        command.env_remove("GITHUB_TOKEN");
        for (key, value) in &self.vars {
            command.env(key, value);
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.vars.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.vars.get(key)
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn profile_overrides_runtime_env() {
        let mut base = ExecutionEnv::new(RepoContext::default());
        base.insert("VK_PROJECT_NAME", "runtime");
        base.insert("FOO", "runtime");

        let mut profile = HashMap::new();
        profile.insert("FOO".to_string(), "profile".to_string());
        profile.insert("BAR".to_string(), "profile".to_string());

        let merged = base.with_overrides(&profile);

        assert_eq!(merged.vars.get("VK_PROJECT_NAME").unwrap(), "runtime");
        assert_eq!(merged.vars.get("FOO").unwrap(), "profile"); // overrides
        assert_eq!(merged.vars.get("BAR").unwrap(), "profile");
    }

    /// Regression for #548: even if the server was launched with
    /// `GH_TOKEN`/`GITHUB_TOKEN` set, agent processes must not inherit it.
    /// `apply_to_command` marks both variables for removal from the child's
    /// env so no coding-agent spawn path can leak the credential.
    #[test]
    fn apply_to_command_scrubs_github_tokens() {
        let env = ExecutionEnv::new(RepoContext::default());
        let mut cmd = Command::new("true");
        env.apply_to_command(&mut cmd);

        let mut removed_gh = false;
        let mut removed_github = false;
        for (key, value) in cmd.as_std().get_envs() {
            if key == OsStr::new("GH_TOKEN") && value.is_none() {
                removed_gh = true;
            }
            if key == OsStr::new("GITHUB_TOKEN") && value.is_none() {
                removed_github = true;
            }
        }
        assert!(removed_gh, "GH_TOKEN must be marked for removal");
        assert!(removed_github, "GITHUB_TOKEN must be marked for removal");
    }

    /// If a caller explicitly puts a GitHub token into the env map, it still
    /// wins — the scrub happens before applying `self.vars`. This preserves
    /// the escape hatch for server-side helpers that legitimately need the
    /// token in a specific subprocess.
    #[test]
    fn apply_to_command_scrub_respects_explicit_override() {
        let mut env = ExecutionEnv::new(RepoContext::default());
        env.insert("GH_TOKEN", "explicit");
        let mut cmd = Command::new("true");
        env.apply_to_command(&mut cmd);

        let value = cmd
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == OsStr::new("GH_TOKEN"))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().into_owned());
        assert_eq!(value.as_deref(), Some("explicit"));
    }
}
