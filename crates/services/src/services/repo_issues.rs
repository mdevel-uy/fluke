use std::path::Path;

use chrono::{DateTime, Utc};
use db::models::{
    repo::Repo,
    repo_issue::{RepoIssue, UpsertRepoIssue},
};
use git::GitService;
use git_host::ProviderKind;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;
use tokio::process::Command;
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path};
use uuid::Uuid;

/// Maximum number of issues to fetch per sync.
const ISSUE_FETCH_LIMIT: u32 = 200;

/// Priority label definitions: (priority_value, label_name, hex_color_without_hash).
const PRIORITY_LABELS: &[(&str, &str, &str)] = &[
    ("urgent", "priority: urgent", "B60205"),
    ("high", "priority: high", "D93F0B"),
    ("medium", "priority: medium", "FBCA04"),
    ("low", "priority: low", "0E8A16"),
];

/// Label as stored in the database: JSON object with name and color.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredLabel {
    pub name: String,
    pub color: String,
}

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
    #[error("Issue not found")]
    IssueNotFound,
    #[error("Invalid priority value: {0}")]
    InvalidPriority(String),
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
            // Each upsert is independent: a failure on one issue does not
            // roll back the others (per-issue atomicity, not all-or-nothing).
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

    /// Set (or clear) the priority label for an issue via the `gh` CLI,
    /// then update the local DB row.
    ///
    /// `priority` — one of "urgent", "high", "medium", "low", or `None` to clear.
    pub async fn set_priority(
        &self,
        pool: &SqlitePool,
        repo_id: Uuid,
        issue_number: i64,
        priority: Option<&str>,
    ) -> Result<(), RepoIssuesError> {
        let repo = Repo::find_by_id(pool, repo_id)
            .await?
            .ok_or(RepoIssuesError::RepoNotFound)?;

        let issue = RepoIssue::find_by_repo_and_number(pool, repo_id, issue_number)
            .await?
            .ok_or(RepoIssuesError::IssueNotFound)?;

        // Parse current labels (support both old string-array and new object-array).
        let mut labels = parse_stored_labels(&issue.labels);

        // Collect names of any priority labels currently on the issue.
        let to_remove: Vec<String> = labels
            .iter()
            .filter(|l| is_priority_label_name(&l.name))
            .map(|l| l.name.clone())
            .collect();

        // Strip all priority labels from our local list.
        labels.retain(|l| !is_priority_label_name(&l.name));

        let gh = resolve_executable_path("gh")
            .await
            .ok_or(RepoIssuesError::GhCliNotAvailable)?;

        // If setting a priority, ensure the label exists in the repo first.
        if let Some(p) = priority {
            let (label_name, label_color) = priority_label_info(p)
                .ok_or_else(|| RepoIssuesError::InvalidPriority(p.to_string()))?;

            let mut create_cmd = Command::new(&gh);
            create_cmd
                .current_dir(&repo.path)
                .args(["label", "create", label_name, "--color", label_color, "--force"]);
            create_cmd.no_window();
            let out = create_cmd.output().await?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(RepoIssuesError::GhCommandFailed(stderr));
            }

            labels.push(StoredLabel {
                name: label_name.to_string(),
                color: label_color.to_string(),
            });
        }

        // Run `gh issue edit` only if there is something to change.
        if priority.is_some() || !to_remove.is_empty() {
            let mut edit_cmd = Command::new(&gh);
            edit_cmd
                .current_dir(&repo.path)
                .arg("issue")
                .arg("edit")
                .arg(issue_number.to_string());

            if !to_remove.is_empty() {
                edit_cmd.arg("--remove-label").arg(to_remove.join(","));
            }

            if let Some(p) = priority {
                let (label_name, _) = priority_label_info(p).unwrap();
                edit_cmd.arg("--add-label").arg(label_name);
            }

            edit_cmd.no_window();
            let out = edit_cmd.output().await?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(RepoIssuesError::GhCommandFailed(stderr));
            }
        }

        let new_labels_json = serde_json::to_string(&labels)?;
        RepoIssue::update_labels(pool, repo_id, issue_number, &new_labels_json).await?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

/// Returns `(label_name, hex_color)` for a priority string, or `None` if unknown.
pub fn priority_label_info(priority: &str) -> Option<(&'static str, &'static str)> {
    PRIORITY_LABELS
        .iter()
        .find(|(p, _, _)| *p == priority.to_lowercase().as_str())
        .map(|(_, name, color)| (*name, *color))
}

/// Returns `true` if the label name is any recognised priority label.
pub fn is_priority_label_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    PRIORITY_LABELS
        .iter()
        .any(|(_, lname, _)| lower == *lname)
        || matches!(lower.as_str(), "p0" | "p1" | "p2" | "p3")
}

/// Derive the highest-urgency priority from a list of stored labels.
pub fn derive_priority(labels: &[StoredLabel]) -> Option<String> {
    let mut best: Option<u8> = None;
    for label in labels {
        let lower = label.name.to_lowercase();
        let rank = match lower.as_str() {
            "p0" | "priority: urgent" => Some(0u8),
            "p1" | "priority: high" => Some(1),
            "p2" | "priority: medium" => Some(2),
            "p3" | "priority: low" => Some(3),
            _ => None,
        };
        if let Some(r) = rank {
            best = Some(best.map_or(r, |b| b.min(r)));
        }
    }
    best.map(|r| {
        match r {
            0 => "urgent",
            1 => "high",
            2 => "medium",
            _ => "low",
        }
        .to_string()
    })
}

/// Parse the labels JSON stored in the DB, supporting both old (string array)
/// and new (object array) formats.
pub fn parse_stored_labels(raw: &str) -> Vec<StoredLabel> {
    serde_json::from_str::<Vec<StoredLabel>>(raw)
        .or_else(|_| {
            let names: Vec<String> = serde_json::from_str(raw)?;
            Ok::<Vec<StoredLabel>, serde_json::Error>(
                names
                    .into_iter()
                    .map(|name| StoredLabel {
                        name,
                        color: String::new(),
                    })
                    .collect(),
            )
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// GitHub remote detection
// ---------------------------------------------------------------------------

fn repo_has_github_remote(git: &GitService, path: &Path) -> bool {
    let remotes = match git.list_remotes(path) {
        Ok(remotes) => remotes,
        Err(err) => {
            tracing::warn!("Failed to list remotes for {}: {}", path.display(), err);
            return false;
        }
    };

    remotes
        .iter()
        .any(|r| detect_provider(&r.url) == ProviderKind::GitHub)
}

fn detect_provider(url: &str) -> ProviderKind {
    let lower = url.to_lowercase();
    if lower.contains("github.com") || lower.contains("github.") {
        if lower.contains("dev.azure.com")
            || lower.contains(".visualstudio.com")
            || lower.contains("/_git/")
        {
            return ProviderKind::AzureDevOps;
        }
        return ProviderKind::GitHub;
    }
    ProviderKind::Unknown
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

// ---------------------------------------------------------------------------
// GitHub issue fetching
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GhIssueAuthor {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhIssueLabel {
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Debug, Deserialize)]
struct GhIssueMilestone {
    title: String,
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
    #[serde(default)]
    milestone: Option<GhIssueMilestone>,
}

impl GhIssue {
    fn into_upsert(self) -> UpsertRepoIssue {
        let labels: Vec<StoredLabel> = self
            .labels
            .into_iter()
            .map(|l| StoredLabel {
                name: l.name,
                color: l.color,
            })
            .collect();
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
            milestone: self.milestone.map(|m| m.title),
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
        .arg("number,title,body,state,labels,author,updatedAt,milestone")
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
