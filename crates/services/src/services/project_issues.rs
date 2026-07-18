use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use db::models::{
    project::Project,
    project_issue::{ProjectIssue, UpsertProjectIssue},
    repo::Repo,
};
use git::GitService;
use git_host::ProviderKind;
use serde::Deserialize;
use sqlx::SqlitePool;
use thiserror::Error;
use tokio::process::Command;
use tracing::warn;
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path};
use uuid::Uuid;

/// Maximum number of issues to fetch per sync.
const ISSUE_FETCH_LIMIT: u32 = 200;

#[derive(Debug, Error)]
pub enum ProjectIssuesError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Project not found")]
    ProjectNotFound,
    #[error("Project has no repository with a GitHub remote")]
    NoGithubRemote,
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
pub struct ProjectIssuesService;

impl ProjectIssuesService {
    pub fn new() -> Self {
        Self
    }

    pub async fn list(
        &self,
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<ProjectIssue>, ProjectIssuesError> {
        ProjectIssue::list_by_project(pool, project_id)
            .await
            .map_err(Into::into)
    }

    /// Sync GitHub issues for every repo of the project that has a GitHub remote.
    ///
    /// Returns the total number of issues upserted across all matching repos.
    pub async fn sync(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        project_id: Uuid,
    ) -> Result<SyncOutcome, ProjectIssuesError> {
        Project::find_by_id(pool, project_id)
            .await?
            .ok_or(ProjectIssuesError::ProjectNotFound)?;

        let repo_ids = Project::repo_ids(pool, project_id).await?;
        let repos = Repo::find_by_ids(pool, &repo_ids).await?;

        let mut github_repo_paths = Vec::new();
        for repo in &repos {
            if let Some(path) = github_repo_path(git, &repo.path) {
                github_repo_paths.push(path);
            }
        }

        if github_repo_paths.is_empty() {
            return Err(ProjectIssuesError::NoGithubRemote);
        }

        let mut synced = 0usize;
        for repo_path in github_repo_paths {
            let issues = fetch_issues(&repo_path).await?;
            for issue in issues {
                ProjectIssue::upsert(pool, project_id, &issue.into_upsert()).await?;
                synced += 1;
            }
        }

        Ok(SyncOutcome { synced })
    }
}

fn github_repo_path(git: &GitService, path: &Path) -> Option<PathBuf> {
    let remotes = match git.list_remotes(path) {
        Ok(remotes) => remotes,
        Err(err) => {
            warn!("Failed to list remotes for {}: {}", path.display(), err);
            return None;
        }
    };

    let has_github = remotes
        .iter()
        .any(|r| detect_provider(&r.url) == ProviderKind::GitHub);

    has_github.then(|| path.to_path_buf())
}

fn detect_provider(url: &str) -> ProviderKind {
    // git-host does not expose its detection helper publicly, but its
    // `GitHostService::from_url` returns `UnsupportedProvider` for
    // non-GitHub / non-Azure remotes, and constructs a `GitHub` variant
    // for GitHub URLs. Use a lightweight local check with the same rules
    // so we do not have to instantiate a provider just to test the URL.
    let lower = url.to_lowercase();
    if lower.contains("github.com") || lower.contains("github.") {
        // Exclude Azure DevOps URLs that happen to contain "github." — none
        // are expected in practice, but guard the /_git/ path just in case.
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
    fn into_upsert(self) -> UpsertProjectIssue {
        let labels: Vec<String> = self.labels.into_iter().map(|l| l.name).collect();
        let state = self
            .state
            .map(|s| s.to_lowercase())
            .unwrap_or_else(|| "open".to_string());
        UpsertProjectIssue {
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

async fn fetch_issues(repo_path: &Path) -> Result<Vec<GhIssue>, ProjectIssuesError> {
    let gh = resolve_executable_path("gh")
        .await
        .ok_or(ProjectIssuesError::GhCliNotAvailable)?;

    let mut cmd = Command::new(gh);
    cmd.current_dir(repo_path)
        .arg("issue")
        .arg("list")
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
        return Err(ProjectIssuesError::GhCommandFailed(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issues: Vec<GhIssue> = serde_json::from_str(stdout.trim())?;
    Ok(issues)
}
