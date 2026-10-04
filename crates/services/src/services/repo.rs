use std::path::{Path, PathBuf};

use db::models::repo::{
    Repo as RepoModel, RepoError as DbRepoError, SearchMatchType, SearchResult, UpdateRepo,
};
use git::{GitService, GitServiceError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;
use ts_rs::TS;
use utils::path::expand_tilde;
use uuid::Uuid;

use super::file_search::{FileSearchCache, SearchQuery};

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Path does not exist: {0}")]
    PathNotFound(PathBuf),
    #[error("Path is not a directory: {0}")]
    PathNotDirectory(PathBuf),
    #[error("Path is not a git repository: {0}")]
    NotGitRepository(PathBuf),
    #[error("Repository not found")]
    NotFound,
    #[error("Directory already exists: {0}")]
    DirectoryAlreadyExists(PathBuf),
    #[error("Git error: {0}")]
    Git(#[from] GitServiceError),
    #[error("Invalid folder name: {0}")]
    InvalidFolderName(String),
    #[error("No GitHub session")]
    GithubSessionRequired,
    #[error("GitHub repository {owner}/{name} already exists")]
    GithubRepoNameTaken { owner: String, name: String },
    #[error("Not allowed to create repositories under {owner}: {message}")]
    GithubOwnerForbidden { owner: String, message: String },
    #[error("GitHub owner not available for this session: {0}")]
    GithubOwnerNotAvailable(String),
    #[error("Invalid GitHub repository name: {0}")]
    InvalidGithubRepoName(String),
    #[error("Repository has no commits yet")]
    NoCommits,
    #[error("Remote origin already configured: {url}")]
    OriginAlreadyConfigured { url: String },
    #[error("GitHub request failed: {0}")]
    GithubRequestFailed(String),
    #[error("GitHub repository {html_url} was created but publishing did not finish: {message}")]
    GithubPublishIncomplete { html_url: String, message: String },
}

pub type Result<T> = std::result::Result<T, RepoError>;

/// Visibility of a repository created on GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum RepoVisibility {
    Public,
    Private,
}

/// A repository as GitHub reports it.
#[derive(Debug, Clone)]
pub struct GithubRepoInfo {
    pub owner: String,
    pub name: String,
    pub html_url: String,
    pub clone_url: String,
    /// True when the repository has no branches yet (freshly created).
    pub is_empty: bool,
}

#[derive(Debug, Clone)]
pub enum GithubCreateError {
    /// No GitHub session (not logged in, or the token was rejected).
    NoSession,
    /// The owner already has a repository with that name.
    NameTaken,
    /// The session cannot create repositories under that owner.
    PermissionDenied(String),
    Other(String),
}

/// The GitHub calls `publish_to_github` needs, behind a trait so tests can
/// replace GitHub with a fake.
pub trait GithubRepoCreator {
    /// Owners the current session can create repositories under (the user
    /// plus their organizations). Without a session: `Err(NoSession)`.
    fn list_owners(&self) -> std::result::Result<Vec<String>, GithubCreateError>;
    fn create_repo(
        &self,
        owner: &str,
        name: &str,
        visibility: RepoVisibility,
    ) -> std::result::Result<GithubRepoInfo, GithubCreateError>;
    /// `Ok(None)` when the repository does not exist (or is not visible).
    fn find_repo(
        &self,
        owner: &str,
        name: &str,
    ) -> std::result::Result<Option<GithubRepoInfo>, GithubCreateError>;
}

#[derive(Debug, Clone)]
pub struct PublishToGithubRequest {
    pub owner: String,
    pub name: String,
    pub visibility: RepoVisibility,
    /// Token for the initial push; `None` uses the machine's git credentials.
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PublishedRepo {
    pub owner: String,
    pub name: String,
    pub html_url: String,
    pub branch: String,
}

const ORIGIN: &str = "origin";

/// GitHub repository names: ASCII letters, digits, `.`, `_` and `-`, at most
/// 100 characters, and not `.` / `..`.
fn is_valid_github_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn map_create_error(err: GithubCreateError, owner: &str, name: &str) -> RepoError {
    match err {
        GithubCreateError::NoSession => RepoError::GithubSessionRequired,
        GithubCreateError::NameTaken => RepoError::GithubRepoNameTaken {
            owner: owner.to_string(),
            name: name.to_string(),
        },
        GithubCreateError::PermissionDenied(message) => RepoError::GithubOwnerForbidden {
            owner: owner.to_string(),
            message,
        },
        GithubCreateError::Other(message) => RepoError::GithubRequestFailed(message),
    }
}

#[derive(Clone, Default)]
pub struct RepoService;

impl RepoService {
    pub fn new() -> Self {
        Self
    }

    fn validate_git_repo_path(&self, path: &Path) -> Result<()> {
        if !path.exists() {
            return Err(RepoError::PathNotFound(path.to_path_buf()));
        }

        if !path.is_dir() {
            return Err(RepoError::PathNotDirectory(path.to_path_buf()));
        }

        if !path.join(".git").exists() {
            return Err(RepoError::NotGitRepository(path.to_path_buf()));
        }

        Ok(())
    }

    pub fn normalize_path(&self, path: &str) -> std::io::Result<PathBuf> {
        std::path::absolute(expand_tilde(path))
    }

    pub async fn register(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        path: &str,
        display_name: Option<&str>,
    ) -> Result<RepoModel> {
        let normalized_path = self.normalize_path(path)?;
        self.validate_git_repo_path(&normalized_path)?;

        let name = normalized_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed".to_string());

        let display_name = display_name.unwrap_or(&name);

        let mut repo = RepoModel::find_or_create(pool, &normalized_path, display_name).await?;

        if repo.default_target_branch.is_none() {
            let branch = git
                .get_remote_default_branch(&normalized_path)
                .or_else(|| git.get_current_branch(&normalized_path).ok());
            if let Some(branch) = branch {
                let update = UpdateRepo {
                    default_target_branch: Some(Some(branch)),
                    display_name: None,
                    setup_script: None,
                    cleanup_script: None,
                    archive_script: None,
                    copy_files: None,
                    parallel_setup_script: None,
                    dev_server_script: None,
                    default_working_dir: None,
                };
                repo = RepoModel::update(pool, repo.id, &update)
                    .await
                    .map_err(|e| match e {
                        DbRepoError::Database(db_err) => RepoError::Database(db_err),
                        DbRepoError::NotFound => RepoError::NotFound,
                    })?;
            }
        }

        Ok(repo)
    }

    pub async fn find_by_id(&self, pool: &SqlitePool, repo_id: Uuid) -> Result<Option<RepoModel>> {
        let repo = RepoModel::find_by_id(pool, repo_id).await?;
        Ok(repo)
    }

    pub async fn get_by_id(&self, pool: &SqlitePool, repo_id: Uuid) -> Result<RepoModel> {
        self.find_by_id(pool, repo_id)
            .await?
            .ok_or(RepoError::NotFound)
    }

    pub async fn init_repo(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        parent_path: &str,
        folder_name: &str,
    ) -> Result<RepoModel> {
        if folder_name.is_empty()
            || folder_name.contains('/')
            || folder_name.contains('\\')
            || folder_name == "."
            || folder_name == ".."
        {
            return Err(RepoError::InvalidFolderName(folder_name.to_string()));
        }

        let normalized_parent = self.normalize_path(parent_path)?;
        if !normalized_parent.exists() {
            return Err(RepoError::PathNotFound(normalized_parent));
        }
        if !normalized_parent.is_dir() {
            return Err(RepoError::PathNotDirectory(normalized_parent));
        }

        let repo_path = normalized_parent.join(folder_name);
        if repo_path.exists() {
            return Err(RepoError::DirectoryAlreadyExists(repo_path));
        }

        git.initialize_repo_with_main_branch(&repo_path)?;

        let mut repo = RepoModel::find_or_create(pool, &repo_path, folder_name).await?;

        if repo.default_target_branch.is_none() {
            let update = UpdateRepo {
                default_target_branch: Some(Some("main".to_string())),
                display_name: None,
                setup_script: None,
                cleanup_script: None,
                archive_script: None,
                copy_files: None,
                parallel_setup_script: None,
                dev_server_script: None,
                default_working_dir: None,
            };
            repo = RepoModel::update(pool, repo.id, &update)
                .await
                .map_err(|e| match e {
                    DbRepoError::Database(db_err) => RepoError::Database(db_err),
                    DbRepoError::NotFound => RepoError::NotFound,
                })?;
        }

        Ok(repo)
    }

    /// Create the repository on GitHub for a local repo, add it as `origin`
    /// and push the current branch.
    ///
    /// Every precondition (git repo, valid name, at least one commit, branch
    /// checked out, no `origin`, GitHub session, allowed owner) is checked
    /// before anything is created. Once the GitHub repo exists, a failure
    /// adding the remote or pushing returns `GithubPublishIncomplete` with
    /// its URL and leaves the local repo without `origin`; retrying the same
    /// request reuses that (still empty) GitHub repo instead of failing with
    /// "name already exists". Blocking: runs git and the creator in-thread.
    pub fn publish_to_github(
        &self,
        git: &GitService,
        creator: &dyn GithubRepoCreator,
        repo_path: &Path,
        req: &PublishToGithubRequest,
    ) -> Result<PublishedRepo> {
        // --- local preconditions (no network, nothing created) ---
        self.validate_git_repo_path(repo_path)?;

        let name = req.name.trim();
        if !is_valid_github_repo_name(name) {
            return Err(RepoError::InvalidGithubRepoName(req.name.clone()));
        }

        if git.get_head_commit(repo_path).is_none() {
            return Err(RepoError::NoCommits);
        }
        if git.get_current_branch(repo_path)? == "HEAD" {
            return Err(RepoError::Git(GitServiceError::InvalidRepository(
                "HEAD is detached; check out a branch before publishing".to_string(),
            )));
        }

        if let Some(origin) = git
            .list_remotes(repo_path)?
            .into_iter()
            .find(|r| r.name == ORIGIN)
        {
            return Err(RepoError::OriginAlreadyConfigured { url: origin.url });
        }

        // --- GitHub preconditions ---
        let requested_owner = req.owner.trim();
        let owners = creator
            .list_owners()
            .map_err(|e| map_create_error(e, requested_owner, name))?;
        let owner = owners
            .into_iter()
            .find(|o| o.eq_ignore_ascii_case(requested_owner))
            .ok_or_else(|| RepoError::GithubOwnerNotAvailable(requested_owner.to_string()))?;

        // --- create (or reuse the empty repo left by a previous attempt) ---
        let info = match creator.create_repo(&owner, name, req.visibility) {
            Ok(info) => info,
            Err(GithubCreateError::NameTaken) => match creator.find_repo(&owner, name) {
                Ok(Some(existing)) if existing.is_empty => existing,
                Err(GithubCreateError::NoSession) => return Err(RepoError::GithubSessionRequired),
                _ => {
                    return Err(RepoError::GithubRepoNameTaken {
                        owner,
                        name: name.to_string(),
                    });
                }
            },
            Err(e) => return Err(map_create_error(e, &owner, name)),
        };

        // --- link and push; never leave a broken origin behind ---
        if let Err(e) = git.add_remote(repo_path, ORIGIN, &info.clone_url) {
            return Err(RepoError::GithubPublishIncomplete {
                html_url: info.html_url,
                message: format!(
                    "adding the origin remote failed ({e}); the local repository has no origin. \
                     Retry to finish: the GitHub repository will be reused."
                ),
            });
        }

        let branch = match git.push_initial(repo_path, ORIGIN, req.token.as_deref()) {
            Ok(branch) => branch,
            Err(push_err) => {
                let local_state = match git.remove_remote(repo_path, ORIGIN) {
                    Ok(()) => "the local repository has no origin".to_string(),
                    Err(e) => format!(
                        "removing the origin remote also failed ({e}); origin still points to {}",
                        info.clone_url
                    ),
                };
                return Err(RepoError::GithubPublishIncomplete {
                    html_url: info.html_url,
                    message: format!(
                        "the initial push failed ({push_err}); {local_state}. \
                         Retry to finish: the GitHub repository will be reused."
                    ),
                });
            }
        };

        Ok(PublishedRepo {
            owner: info.owner,
            name: info.name,
            html_url: info.html_url,
            branch,
        })
    }

    pub async fn search_files(
        &self,
        cache: &FileSearchCache,
        repositories: &[RepoModel],
        query: &SearchQuery,
    ) -> Result<Vec<SearchResult>> {
        let query_str = query.q.trim();
        if query_str.is_empty() || repositories.is_empty() {
            return Ok(vec![]);
        }

        // Search in parallel and prefix paths with repo name
        let search_futures: Vec<_> = repositories
            .iter()
            .map(|repo| {
                let repo_name = repo.name.clone();
                let repo_path = repo.path.clone();
                let mode = query.mode.clone();
                let query_str = query_str.to_string();
                async move {
                    let results = cache
                        .search_repo(&repo_path, &query_str, mode)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::warn!("Search failed for repo {}: {}", repo_name, e);
                            vec![]
                        });
                    (repo_name, results)
                }
            })
            .collect();

        let repo_results = futures::future::join_all(search_futures).await;

        let mut all_results: Vec<SearchResult> = repo_results
            .into_iter()
            .flat_map(|(repo_name, results)| {
                results.into_iter().map(move |r| SearchResult {
                    path: format!("{}/{}", repo_name, r.path),
                    is_file: r.is_file,
                    match_type: r.match_type.clone(),
                    score: r.score,
                })
            })
            .collect();

        all_results.sort_by(|a, b| {
            let priority = |m: &SearchMatchType| match m {
                SearchMatchType::FileName => 0,
                SearchMatchType::DirectoryName => 1,
                SearchMatchType::FullPath => 2,
            };
            priority(&a.match_type)
                .cmp(&priority(&b.match_type))
                .then_with(|| b.score.cmp(&a.score)) // Higher scores first
        });

        all_results.truncate(10);
        Ok(all_results)
    }
}
