use std::path::Path;

use chrono::{DateTime, Utc};
use db::models::{
    repo::Repo,
    repo_issue::{RepoIssue, UpsertRepoIssue},
};
use git::GitService;
use serde::Deserialize;
use sqlx::SqlitePool;
use thiserror::Error;
use tokio::process::Command;
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path};
use uuid::Uuid;

/// Maximum number of issues to fetch per sync.
const ISSUE_FETCH_LIMIT: u32 = 200;

#[derive(Debug, Error)]
pub enum RepoIssuesError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Repository not found")]
    RepoNotFound,
    #[error("Repository has no GitHub remote")]
    NoGithubRemote,
    #[error("origin remote URL is not a GitHub URL: {0}")]
    NotGithubOrigin(String),
    #[error("`gh` CLI is not installed or not on PATH")]
    GhCliNotAvailable,
    #[error("`gh issue list` failed: {0}")]
    GhCommandFailed(String),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SyncOutcome {
    pub synced: usize,
}

#[derive(Clone, Default)]
pub struct RepoIssuesService;

impl RepoIssuesService {
    pub fn new() -> Self {
        Self
    }

    pub async fn list(
        &self,
        pool: &SqlitePool,
        repo_id: Uuid,
    ) -> Result<Vec<RepoIssue>, RepoIssuesError> {
        RepoIssue::list_by_repo(pool, repo_id)
            .await
            .map_err(Into::into)
    }

    /// Sync GitHub issues for the given repo if it has a GitHub remote.
    ///
    /// Returns the total number of issues upserted.
    pub async fn sync(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        repo_id: Uuid,
    ) -> Result<SyncOutcome, RepoIssuesError> {
        let repo = Repo::find_by_id(pool, repo_id)
            .await?
            .ok_or(RepoIssuesError::RepoNotFound)?;

        let nwo = get_github_nwo(git, &repo.path)?;

        let issues = fetch_issues(&repo.path, &nwo).await?;
        let mut synced = 0usize;
        let mut numbers: Vec<i64> = Vec::with_capacity(issues.len());
        for issue in issues {
            numbers.push(issue.number);
            RepoIssue::upsert(pool, repo_id, &issue.into_upsert()).await?;
            synced += 1;
        }

        let pruned = RepoIssue::delete_not_in(pool, repo_id, &numbers).await?;
        if pruned > 0 {
            tracing::info!(repo_id = %repo_id, pruned, "pruned stale issues after sync");
        }

        Ok(SyncOutcome { synced })
    }
}

/// Resolve `owner/repo` from the `origin` remote of the given repository.
///
/// Returns an error if the remote is missing or its URL is not a GitHub URL,
/// so callers get a clear diagnostic instead of silently syncing the wrong repo.
fn get_github_nwo(git: &GitService, path: &Path) -> Result<String, RepoIssuesError> {
    let url = git
        .get_remote_url(path, "origin")
        .map_err(|_| RepoIssuesError::NoGithubRemote)?;

    extract_github_nwo(&url).ok_or_else(|| RepoIssuesError::NotGithubOrigin(url))
}

/// Parse `owner/repo` out of a GitHub remote URL.
///
/// Handles both HTTPS (`https://github.com/owner/repo[.git]`) and
/// SSH (`git@github.com:owner/repo[.git]`) formats.
fn extract_github_nwo(url: &str) -> Option<String> {
    let lower = url.to_lowercase();

    // Find the start of the path component after the host.
    // SSH uses a colon separator; HTTPS uses a slash.
    let path = if let Some(pos) = lower.find("github.com:") {
        &url[pos + "github.com:".len()..]
    } else if let Some(pos) = lower.find("github.com/") {
        &url[pos + "github.com/".len()..]
    } else {
        return None;
    };

    // Strip optional trailing .git suffix and slashes.
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_end_matches('/');

    // Accept exactly owner/repo — one slash, non-empty on both sides.
    if path.matches('/').count() == 1 && !path.starts_with('/') {
        Some(path.to_string())
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
struct GhIssueAuthor {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhIssueLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssue {
    number: i64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    labels: Vec<GhIssueLabel>,
    #[serde(default)]
    author: Option<GhIssueAuthor>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
}

impl GhIssue {
    fn into_upsert(self) -> UpsertRepoIssue {
        let labels: Vec<String> = self.labels.into_iter().map(|l| l.name).collect();
        let state = self
            .state
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "open".to_string());
        UpsertRepoIssue {
            number: self.number,
            title: self.title,
            body: self.body,
            state,
            labels: serde_json::to_string(&labels).unwrap_or_else(|_| "[]".to_string()),
            author: self.author.and_then(|a| a.login),
            updated_at: self.updated_at.unwrap_or_else(Utc::now),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_github_nwo_https() {
        assert_eq!(
            extract_github_nwo("https://github.com/owner/repo.git"),
            Some("owner/repo".to_string())
        );
        assert_eq!(
            extract_github_nwo("https://github.com/owner/repo"),
            Some("owner/repo".to_string())
        );
    }

    #[test]
    fn test_extract_github_nwo_ssh() {
        assert_eq!(
            extract_github_nwo("git@github.com:owner/repo.git"),
            Some("owner/repo".to_string())
        );
        assert_eq!(
            extract_github_nwo("git@github.com:owner/repo"),
            Some("owner/repo".to_string())
        );
    }

    #[test]
    fn test_extract_github_nwo_non_github() {
        assert_eq!(
            extract_github_nwo("https://gitlab.com/owner/repo.git"),
            None
        );
        assert_eq!(extract_github_nwo("git@bitbucket.org:owner/repo.git"), None);
        assert_eq!(extract_github_nwo(""), None);
    }

    #[test]
    fn test_extract_github_nwo_rejects_deep_path() {
        assert_eq!(
            extract_github_nwo("https://github.com/owner/repo/extra"),
            None
        );
    }
}

async fn fetch_issues(repo_path: &Path, nwo: &str) -> Result<Vec<GhIssue>, RepoIssuesError> {
    let gh = resolve_executable_path("gh")
        .await
        .ok_or(RepoIssuesError::GhCliNotAvailable)?;

    let mut cmd = Command::new(gh);
    cmd.current_dir(repo_path)
        .arg("issue")
        .arg("list")
        .arg("-R")
        .arg(nwo)
        .arg("--state")
        .arg("all")
        .arg("--json")
        .arg("number,title,body,state,labels,author,updatedAt")
        .arg("--limit")
        .arg(ISSUE_FETCH_LIMIT.to_string());
    cmd.no_window();

    let output = cmd.output().await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(RepoIssuesError::GhCommandFailed(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issues: Vec<GhIssue> = serde_json::from_str(stdout.trim())?;
    Ok(issues)
}
