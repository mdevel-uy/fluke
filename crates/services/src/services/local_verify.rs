//! Local verification of PR heads for repos without CI.
//!
//! Agent worktrees start without `node_modules` or a build cache, so agents
//! do not run checks. When GitHub reports no checks for a PR, the pr_monitor
//! asks this module instead: the repo's `.fluke/verify` file holds one
//! command line (run with `cmd /C` on Windows, `sh -c` elsewhere) that is
//! executed against the PR head in a single persistent checkout per repo.
//! That checkout keeps its ignored files (`node_modules`, `target/`) between
//! runs, so after the first build every verification is incremental, and
//! runs are serialized so the machine never has more than one at a time.

use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use tokio::process::Command;
use utils::{assets::asset_dir, command_ext::NoWindowExt, shell::get_shell_command};
use uuid::Uuid;

/// Path, relative to the repo root, of the file holding the verify command.
pub const VERIFY_FILE: &str = ".fluke/verify";
const LOG_TAIL_BYTES: usize = 8 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(45 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// The repo has no `.fluke/verify` at this head: nothing to run.
    NotConfigured,
    /// Queued or running; ask again on the next poll.
    Pending,
    Passed,
    /// The command failed; holds the tail of its output.
    Failed(String),
}

// ponytail: in-memory and keyed by head SHA, so a restart re-verifies open
// PRs (cheap, the checkout stays warm) and the map grows by one short entry
// per verified head; prune it if fluke ever runs for months without restart.
static RESULTS: LazyLock<Mutex<HashMap<String, Gate>>> = LazyLock::new(Default::default);
static RUNNER: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

/// Verification state of `head_sha` (PR `pr_number` of the repo at
/// `repo_path`), starting a run in the background when there is none yet.
pub async fn gate(repo_path: &Path, repo_id: Uuid, pr_number: i64, head_sha: &str) -> Gate {
    if let Some(gate) = RESULTS.lock().unwrap().get(head_sha) {
        return gate.clone();
    }
    // Bring the head into the local repo so its verify file can be read and
    // the verify checkout can switch to it.
    let refspec = format!("+refs/pull/{pr_number}/head:refs/fluke/verify/{pr_number}");
    if let Err(e) = git(repo_path, &["fetch", "--quiet", "origin", &refspec]).await {
        tracing::warn!(
            pr_number,
            "Local verify: fetch of the PR head failed, retrying next poll: {e}"
        );
        return Gate::Pending;
    }
    let command = match git(repo_path, &["show", &format!("{head_sha}:{VERIFY_FILE}")]).await {
        Ok(out) => out.trim().to_string(),
        Err(_) => String::new(),
    };
    let mut results = RESULTS.lock().unwrap();
    if let Some(gate) = results.get(head_sha) {
        return gate.clone();
    }
    if command.is_empty() {
        results.insert(head_sha.to_string(), Gate::NotConfigured);
        return Gate::NotConfigured;
    }
    results.insert(head_sha.to_string(), Gate::Pending);
    drop(results);

    let (repo_path, head_sha) = (repo_path.to_path_buf(), head_sha.to_string());
    tokio::spawn(async move {
        match run(&repo_path, repo_id, &head_sha, &command).await {
            Ok(gate) => {
                tracing::info!(pr_number, head_sha, ?gate, "Local verify finished");
                RESULTS.lock().unwrap().insert(head_sha, gate);
            }
            Err(e) => {
                // Infra problem (git, spawn), not the PR's fault: forget the
                // entry so the next poll retries instead of blaming the agent.
                tracing::warn!(pr_number, head_sha, "Local verify could not run: {e}");
                RESULTS.lock().unwrap().remove(&head_sha);
            }
        }
    });
    Gate::Pending
}

/// Output tail of a failed verification of `head_sha`, if there was one.
pub fn failure_log(head_sha: &str) -> Option<String> {
    match RESULTS.lock().unwrap().get(head_sha) {
        Some(Gate::Failed(log)) => Some(log.clone()),
        _ => None,
    }
}

async fn run(
    repo_path: &Path,
    repo_id: Uuid,
    head_sha: &str,
    command: &str,
) -> Result<Gate, String> {
    let _turn = RUNNER.lock().await;
    let dir = asset_dir().join("verify").join(repo_id.to_string());
    if dir.join(".git").exists() {
        git(
            &dir,
            &["checkout", "--quiet", "--force", "--detach", head_sha],
        )
        .await?;
        // No -x: ignored files (node_modules, target/) are the warm cache.
        git(&dir, &["clean", "--quiet", "-fd"]).await?;
    } else {
        let dir_str = dir.to_string_lossy();
        git(repo_path, &["worktree", "prune"]).await?;
        git(
            repo_path,
            &["worktree", "add", "--force", "--detach", &dir_str, head_sha],
        )
        .await?;
    }

    let (shell, arg) = get_shell_command();
    let jobs = std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).max(1));
    let mut cmd = Command::new(shell);
    cmd.arg(arg)
        .arg(command)
        .current_dir(&dir)
        .env("CI", "true")
        .env("CARGO_BUILD_JOBS", jobs.to_string())
        .kill_on_drop(true)
        .no_window();
    let output = match tokio::time::timeout(RUN_TIMEOUT, cmd.output()).await {
        Ok(out) => out.map_err(|e| format!("spawn `{command}`: {e}"))?,
        Err(_) => {
            return Ok(Gate::Failed(format!(
                "`{command}` did not finish within {} minutes",
                RUN_TIMEOUT.as_secs() / 60
            )));
        }
    };
    if output.status.success() {
        return Ok(Gate::Passed);
    }
    let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(Gate::Failed(tail(&log, LOG_TAIL_BYTES)))
}

async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .no_window()
        .output()
        .await
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Last `max` bytes of `s`, cut at a char boundary.
fn tail(s: &str, max: usize) -> String {
    let mut start = s.len().saturating_sub(max);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        assert_eq!(tail("abc", 10), "abc");
        assert_eq!(tail("abcdef", 3), "def");
        // 'é' is two bytes; a cut through it moves forward.
        assert_eq!(tail("xé", 1), "");
        assert_eq!(tail("xéz", 2), "z");
    }
}
