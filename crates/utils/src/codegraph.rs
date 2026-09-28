//! Optional integration with codegraph (github.com/colbymchenry/codegraph):
//! a local code-graph index exposed to agents as an MCP server. Everything
//! here is a no-op when the `codegraph` binary is not installed.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{LazyLock, Mutex},
};

use tokio::process::Command;

use crate::{command_ext::NoWindowExt, shell::resolve_executable_path};

const INDEX_DIR: &str = ".codegraph";
const INDEX_DB: &str = "codegraph.db";

/// Locate the `codegraph` launcher: PATH first, then the official
/// installers' default locations (they edit the user PATH, which a running
/// app or a login shell may not have picked up yet).
pub async fn codegraph_path() -> Option<PathBuf> {
    if let Some(found) = resolve_executable_path("codegraph").await {
        return Some(found);
    }
    let fallback = if cfg!(windows) {
        dirs::data_local_dir().map(|d| d.join(r"codegraph\current\bin\codegraph.cmd"))
    } else {
        dirs::home_dir().map(|h| h.join(".local/bin/codegraph"))
    };
    fallback.filter(|p| p.is_file())
}

/// Write the MCP config handed to agent sessions via `--mcp-config`, so the
/// server is only active inside fluke and the user's own agent config stays
/// untouched. Returns `None` when codegraph is not installed.
pub async fn mcp_config_file() -> Option<PathBuf> {
    let bin = codegraph_path().await?;
    let bin_str = bin.to_string_lossy().to_string();
    // Windows installs a .cmd launcher, which Node (Claude Code) can't spawn
    // without a shell.
    // ponytail: `cmd /c` mangles paths with spaces + quotes; switch to the
    // bundled node.exe entrypoint if a user profile path with spaces breaks it.
    let (command, mut args) = if cfg!(windows) && bin_str.to_lowercase().ends_with(".cmd") {
        ("cmd".to_string(), vec!["/c".to_string(), bin_str])
    } else {
        (bin_str, vec![])
    };
    args.extend(["serve".to_string(), "--mcp".to_string()]);

    let config = serde_json::json!({
        "mcpServers": {
            "codegraph": {
                "command": command,
                "args": args,
                "env": { "CODEGRAPH_TELEMETRY": "0" }
            }
        }
    });
    let path = crate::assets::asset_dir().join("codegraph-mcp.json");
    match tokio::fs::write(&path, config.to_string()).await {
        Ok(()) => Some(path),
        Err(e) => {
            tracing::warn!("codegraph: could not write MCP config {path:?}: {e}");
            None
        }
    }
}

/// Repos with a background `codegraph init` in flight.
static INDEXING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

/// Give a freshly created worktree the base repo's index, so the agent starts
/// with a warm graph (codegraph stores repo-relative paths and reconciles the
/// diff on connect). If the base repo has no index yet, build it in the
/// background: this worktree goes without, the following ones get the copy.
pub async fn seed_worktree_index(repo_path: &Path, worktree_path: &Path) {
    let Some(bin) = codegraph_path().await else {
        return;
    };
    exclude_index_dir(repo_path);

    let src = repo_path.join(INDEX_DIR);
    if src.join(INDEX_DB).is_file() {
        let dst = worktree_path.join(INDEX_DIR);
        if let Err(e) = copy_index(&src, &dst) {
            tracing::warn!("codegraph: could not seed index into {worktree_path:?}: {e}");
        }
        return;
    }

    if !INDEXING.lock().unwrap().insert(repo_path.to_path_buf()) {
        return;
    }
    let repo = repo_path.to_path_buf();
    tokio::spawn(async move {
        tracing::info!("codegraph: indexing {repo:?} in the background");
        let status = Command::new(&bin)
            .args(["init", "-y"])
            .arg(&repo)
            .env("CODEGRAPH_TELEMETRY", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .status()
            .await;
        match status {
            Ok(s) if s.success() => tracing::info!("codegraph: indexed {repo:?}"),
            other => tracing::warn!("codegraph: indexing {repo:?} failed: {other:?}"),
        }
        INDEXING.lock().unwrap().remove(&repo);
    });
}

// ponytail: copies while a writer may be checkpointing the source; the
// connect-time catch-up re-hashes files, but a torn copy would need a re-init.
fn copy_index(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for name in [INDEX_DB, "codegraph.db-wal"] {
        let from = src.join(name);
        if from.is_file() {
            std::fs::copy(&from, dst.join(name))?;
        }
    }
    Ok(())
}

/// Keep `.codegraph/` out of commits. `info/exclude` lives in the common git
/// dir, so one entry covers the base checkout and every worktree.
fn exclude_index_dir(repo_path: &Path) {
    let exclude = repo_path.join(".git").join("info").join("exclude");
    let Some(parent) = exclude
        .parent()
        .filter(|p| p.parent().is_some_and(Path::is_dir))
    else {
        return;
    };
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == "/.codegraph/") {
        return;
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let result = std::fs::create_dir_all(parent)
        .and_then(|()| std::fs::write(&exclude, format!("{current}{sep}/.codegraph/\n")));
    if let Err(e) = result {
        tracing::warn!("codegraph: could not update {exclude:?}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_is_added_once() {
        let dir = std::env::temp_dir().join(format!("cg-exclude-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        exclude_index_dir(&dir);
        exclude_index_dir(&dir);
        let content = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(content.matches("/.codegraph/").count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn exclude_skips_worktree_style_git_file() {
        let dir = std::env::temp_dir().join(format!("cg-gitfile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".git"), "gitdir: elsewhere").unwrap();
        exclude_index_dir(&dir);
        assert!(!dir.join(".git/info").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
