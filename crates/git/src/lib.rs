use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use git2::{BranchType, DiffOptions, Error as GitError, Reference, Remote, Repository, Sort};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;
use utils::diff::{Diff, DiffChangeKind};

mod cli;
mod validation;

use cli::{ChangeType, StatusDiffEntry, StatusDiffOptions};
pub use cli::{GitCli, GitCliError, StatusEntry, WorktreeStatus};
pub use utils::path::ALWAYS_SKIP_DIRS;
pub use validation::is_valid_branch_prefix;

/// Statistics for a single file based on git history
#[derive(Clone, Debug)]
pub struct FileStat {
    /// Index in the commit history (0 = HEAD, 1 = parent of HEAD, ...)
    pub last_index: usize,
    /// Number of times this file was changed in recent commits
    pub commit_count: u32,
    /// Timestamp of the most recent change
    pub last_time: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum GitServiceError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    GitCLI(#[from] GitCliError),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("Invalid repository: {0}")]
    InvalidRepository(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
    #[error("Merge conflicts: {message}")]
    MergeConflicts {
        message: String,
        conflicted_files: Vec<String>,
    },
    #[error("Branches diverged: {0}")]
    BranchesDiverged(String),
    #[error("{0} has uncommitted changes: {1}")]
    WorktreeDirty(String, String),
    #[error("Rebase in progress; resolve or abort it before retrying")]
    RebaseInProgress,
}

impl GitServiceError {
    /// True when the underlying git2 error is "a reference with that name
    /// already exists" (e.g. creating a branch that is already there).
    pub fn is_ref_exists(&self) -> bool {
        matches!(self, GitServiceError::Git(e) if e.code() == git2::ErrorCode::Exists)
    }
}

/// Service for managing Git operations in task execution workflows
#[derive(Clone)]
pub struct GitService {}

// Max inline diff size for UI (in bytes). Files larger than this will have
// their contents omitted from the diff stream to avoid UI crashes.
const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024; // ~2MB

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ConflictOp {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

#[derive(Debug, Serialize, TS)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    #[ts(type = "Date")]
    pub last_commit_date: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

/// Tag + target commit, mirrored inline in the frontend client.
#[derive(Debug, Clone, Serialize)]
pub struct GitTagInfo {
    pub name: String,
    pub target_oid: String,
}

/// Entry of a directory listing at a commit (mirrored inline in the client).
#[derive(Debug, Clone, Serialize)]
pub struct CommitTreeEntry {
    pub name: String,
    pub is_directory: bool,
}

// Commit detail for the source-control aside (mirrored inline in the client).

#[derive(Debug, Clone, Serialize)]
pub struct CommitFileChange {
    pub path: String,
    /// "added" | "deleted" | "modified" | "renamed"
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    /// Full commit message (subject + body).
    pub message: String,
    pub author: String,
    pub author_email: String,
    pub committed_at: DateTime<Utc>,
    pub parent_oids: Vec<String>,
    pub files: Vec<CommitFileChange>,
    pub additions: usize,
    pub deletions: usize,
}

// Fleet graph (SHELL-SPEC V4): multi-branch revwalk over the base branch
// plus the attempt-branch tips. Mirrored inline in the frontend client
// (like the editor endpoints), so not part of generate_types.

#[derive(Debug, Clone, Serialize)]
pub struct FleetGraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub parent_oids: Vec<String>,
    pub summary: String,
    pub author: String,
    pub committed_at: DateTime<Utc>,
    /// Attempt branch this commit is exclusive to; `None` = reachable from base.
    pub branch: Option<String>,
    /// Branch names whose tip is exactly this commit.
    pub tip_of: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FleetGraphTip {
    pub branch: String,
    pub oid: String,
    pub ahead_from_base: usize,
    pub behind_from_base: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FleetGraph {
    pub base_branch: String,
    pub commits: Vec<FleetGraphCommit>,
    pub tips: Vec<FleetGraphTip>,
    /// More history exists past this page (`offset + limit` window).
    pub has_more: bool,
}

// Selective staging (SHELL-SPEC V5/R38): index-aware view of the worktree.
// Mirrored inline in the frontend client — not part of generate_types.

#[derive(Debug, Clone, Serialize)]
pub struct StagingHunk {
    /// The `@@ -a,b +c,d @@ ctx` header line.
    pub header: String,
    /// Raw diff body lines (leading ' ', '+', '-' or '\').
    pub lines: Vec<String>,
    /// Standalone patch (file headers + this hunk) for `git apply --cached`.
    pub patch: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagingFile {
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub status: String,
    pub is_binary: bool,
    pub staged_hunks: Vec<StagingHunk>,
    pub unstaged_hunks: Vec<StagingHunk>,
    pub has_staged_changes: bool,
    pub has_unstaged_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagingState {
    pub files: Vec<StagingFile>,
}

#[derive(Debug, Default)]
struct ParsedDiffFile {
    path: String,
    header: Vec<String>,
    is_binary: bool,
    hunks: Vec<StagingHunk>,
}

/// Parse `git diff` unified output into files + hunks, building a standalone
/// per-hunk patch (file header block + hunk) ready for `git apply --cached`.
fn parse_unified_diff(diff: &str) -> Vec<ParsedDiffFile> {
    let mut files: Vec<ParsedDiffFile> = Vec::new();
    let mut current: Option<ParsedDiffFile> = None;
    let mut in_hunks = false;

    let finish = |file: Option<ParsedDiffFile>, files: &mut Vec<ParsedDiffFile>| {
        if let Some(mut file) = file {
            let header_block = file.header.join("\n");
            for hunk in &mut file.hunks {
                let body = hunk.lines.join("\n");
                let mut patch = format!("{header_block}\n{}\n", hunk.header);
                if !body.is_empty() {
                    patch.push_str(&body);
                    patch.push('\n');
                }
                hunk.patch = patch;
            }
            files.push(file);
        }
    };

    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            finish(current.take(), &mut files);
            current = Some(ParsedDiffFile {
                header: vec![line.to_string()],
                ..Default::default()
            });
            in_hunks = false;
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        if line.starts_with("@@") {
            in_hunks = true;
            file.hunks.push(StagingHunk {
                header: line.to_string(),
                lines: Vec::new(),
                patch: String::new(),
                added: 0,
                removed: 0,
            });
            continue;
        }
        if in_hunks {
            if let Some(hunk) = file.hunks.last_mut() {
                if line.starts_with('+') {
                    hunk.added += 1;
                } else if line.starts_with('-') {
                    hunk.removed += 1;
                }
                hunk.lines.push(line.to_string());
            }
            continue;
        }
        if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
            file.is_binary = true;
        }
        if let Some(path) = line.strip_prefix("+++ b/") {
            file.path = path.to_string();
        } else if let Some(path) = line.strip_prefix("--- a/")
            && file.path.is_empty()
        {
            file.path = path.to_string();
        }
        file.header.push(line.to_string());
    }
    finish(current, &mut files);
    files
}

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub branch: String,
    pub oid: String,
}

#[derive(Debug, Clone)]
pub struct Commit(git2::Oid);

impl Commit {
    pub fn new(id: git2::Oid) -> Self {
        Self(id)
    }
    pub fn as_oid(&self) -> git2::Oid {
        self.0
    }
}

impl std::fmt::Display for Commit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WorktreeResetOptions {
    pub perform_reset: bool,
    pub force_when_dirty: bool,
    pub is_dirty: bool,
    pub log_skip_when_dirty: bool,
}

impl WorktreeResetOptions {
    pub fn new(
        perform_reset: bool,
        force_when_dirty: bool,
        is_dirty: bool,
        log_skip_when_dirty: bool,
    ) -> Self {
        Self {
            perform_reset,
            force_when_dirty,
            is_dirty,
            log_skip_when_dirty,
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WorktreeResetOutcome {
    pub needed: bool,
    pub applied: bool,
}

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}

impl GitService {
    /// Create a new GitService for the given repository path
    pub fn new() -> Self {
        Self {}
    }

    pub fn is_branch_name_valid(&self, name: &str) -> bool {
        git2::Branch::name_is_valid(name).unwrap_or(false)
    }

    /// Open the repository
    pub(crate) fn open_repo(&self, repo_path: &Path) -> Result<Repository, GitServiceError> {
        Repository::open(repo_path).map_err(GitServiceError::from)
    }

    /// Returns whether a path can be opened as a git repository.
    pub fn is_repo_openable(&self, repo_path: &Path) -> bool {
        Repository::open(repo_path).is_ok()
    }

    /// Returns the `.git` directory (or worktree gitdir) for the given repo path.
    pub fn get_git_dir(&self, repo_path: &Path) -> Result<PathBuf, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        Ok(repo.path().to_path_buf())
    }

    /// Returns the common directory (shared `.git` dir across worktrees).
    pub fn get_common_dir(&self, repo_path: &Path) -> Result<PathBuf, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        Ok(repo.commondir().to_path_buf())
    }

    /// Checks if a named worktree is valid/registered in the repository.
    pub fn validate_worktree(
        &self,
        repo_path: &Path,
        worktree_name: &str,
    ) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        Ok(repo.find_worktree(worktree_name).is_ok())
    }

    /// Create a new local branch pointing at the tip of `base_branch_name`.
    pub fn create_branch(
        &self,
        repo_path: &Path,
        new_branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let base_ref = Self::find_branch(&repo, base_branch_name)?.into_reference();
        let commit = base_ref.peel_to_commit()?;
        repo.branch(new_branch_name, &commit, false)?;
        Ok(())
    }

    /// Create `new_branch` at the tip of `base_branch` plus one commit
    /// containing `files` (repo-relative path → content). The tree is built
    /// entirely in memory with git2: the working tree and the checked-out
    /// branch are never touched, so this is safe to run against a repo the
    /// user is actively working in. Returns the new commit id.
    pub fn commit_files_to_new_branch(
        &self,
        repo_path: &Path,
        base_branch: &str,
        new_branch: &str,
        files: &[(String, String)],
        message: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        if repo.find_branch(new_branch, BranchType::Local).is_ok() {
            return Err(GitServiceError::Git(GitError::new(
                git2::ErrorCode::Exists,
                git2::ErrorClass::Reference,
                format!("branch '{new_branch}' already exists"),
            )));
        }
        let base_ref = Self::find_branch(&repo, base_branch)?.into_reference();
        let base_commit = base_ref.peel_to_commit()?;
        let base_tree = base_commit.tree()?;

        let mut builder = git2::build::TreeUpdateBuilder::new();
        for (rel_path, content) in files {
            let blob = repo.blob(content.as_bytes())?;
            builder.upsert(rel_path, blob, git2::FileMode::Blob);
        }
        let tree_oid = builder.create_updated(&repo, &base_tree)?;
        let tree = repo.find_tree(tree_oid)?;

        let signature = self.signature_with_fallback(&repo)?;
        let commit_oid = repo.commit(
            None,
            &signature,
            &signature,
            message,
            &tree,
            &[&base_commit],
        )?;
        let commit = repo.find_commit(commit_oid)?;
        repo.branch(new_branch, &commit, false)?;
        Ok(commit_oid.to_string())
    }

    /// Push a local branch from the main repository without requiring a
    /// clean working tree — used for branches built in memory (the push has
    /// nothing to do with the working tree's state).
    pub fn push_branch_with_token(
        &self,
        repo_path: &Path,
        branch_name: &str,
        force: bool,
        token: Option<&str>,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let remote = self.default_remote(&repo, repo_path)?;
        let git_cli = GitCli::new();
        git_cli.push_with_token(repo_path, &remote.url, branch_name, branch_name, force, token)?;
        if let Err(e) = Self::update_tracking_after_push(&repo, branch_name, &remote.name, branch_name) {
            tracing::warn!(
                "Pushed '{branch_name}' but could not update tracking ref/upstream: {e}"
            );
        }
        Ok(())
    }

    /// Ensure local (repo-scoped) identity exists for CLI commits.
    /// Sets user.name/email only if missing in the repo config.
    fn ensure_cli_commit_identity(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let cfg = repo.config()?;
        let has_name = cfg.get_string("user.name").is_ok();
        let has_email = cfg.get_string("user.email").is_ok();
        if !(has_name && has_email) {
            let mut cfg = repo.config()?;
            cfg.set_str("user.name", "mkanban")?;
            cfg.set_str("user.email", "noreply@mkanban.dev")?;
        }
        Ok(())
    }

    /// Get a signature for libgit2 commits with a safe fallback identity.
    fn signature_with_fallback<'a>(
        &self,
        repo: &'a Repository,
    ) -> Result<git2::Signature<'a>, GitServiceError> {
        match repo.signature() {
            Ok(sig) => Ok(sig),
            Err(_) => git2::Signature::now("mkanban", "noreply@mkanban.dev")
                .map_err(GitServiceError::from),
        }
    }

    fn default_remote(
        &self,
        repo: &Repository,
        repo_path: &Path,
    ) -> Result<GitRemote, GitServiceError> {
        let mut remotes = GitCli::new().list_remotes(repo_path)?;

        // Check for pushDefault config
        if let Ok(config) = repo.config()
            && let Ok(default_name) = config.get_string("remote.pushDefault")
            && let Some(idx) = remotes.iter().position(|(name, _)| name == &default_name)
        {
            let (name, url) = remotes.swap_remove(idx);
            return Ok(GitRemote { name, url });
        }

        // Fall back to first remote
        remotes
            .into_iter()
            .next()
            .map(|(name, url)| GitRemote { name, url })
            .ok_or_else(|| GitServiceError::InvalidRepository("No remotes configured".to_string()))
    }

    /// Initialize a new git repository with a main branch and initial commit
    pub fn initialize_repo_with_main_branch(
        &self,
        repo_path: &Path,
    ) -> Result<(), GitServiceError> {
        // Create directory if it doesn't exist
        if !repo_path.exists() {
            std::fs::create_dir_all(repo_path)?;
        }

        // Initialize git repository with main branch
        let repo = Repository::init_opts(
            repo_path,
            git2::RepositoryInitOptions::new()
                .initial_head("main")
                .mkdir(true),
        )?;

        // Create initial commit
        self.create_initial_commit(&repo)?;

        Ok(())
    }

    fn create_initial_commit(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let signature = self.signature_with_fallback(repo)?;

        let tree_id = {
            let tree_builder = repo.treebuilder(None)?;
            tree_builder.write()?
        };
        let tree = repo.find_tree(tree_id)?;

        // Create initial commit on main branch
        let _commit_id = repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        )?;

        // Set HEAD to point to main branch
        repo.set_head("refs/heads/main")?;

        Ok(())
    }

    pub fn commit(&self, path: &Path, message: &str) -> Result<bool, GitServiceError> {
        // Use Git CLI to respect sparse-checkout semantics for staging and commit
        let git = GitCli::new();
        let has_changes = git
            .has_changes(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))?;
        if !has_changes {
            tracing::debug!("No changes to commit!");
            return Ok(false);
        }

        git.add_all(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git add failed: {e}")))?;
        // Only ensure identity once we know we're about to commit
        self.ensure_cli_commit_identity(path)?;
        git.commit(path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))?;
        Ok(true)
    }

    /// Get worktree diffs against a base commit
    pub fn get_diffs(
        &self,
        worktree_path: &Path,
        base_commit: &Commit,
        path_filter: Option<&[&str]>,
    ) -> Result<Vec<Diff>, GitServiceError> {
        // Use Git CLI to compute diff vs base to avoid sparse false deletions
        let repo = Repository::open(worktree_path)?;
        let base_tree = repo
            .find_commit(base_commit.as_oid())?
            .tree()
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("Failed to find base commit tree: {e}"))
            })?;

        let git = GitCli::new();
        let cli_opts = StatusDiffOptions {
            path_filter: path_filter.map(|fs| fs.iter().map(|s| s.to_string()).collect()),
        };
        let entries = git
            .diff_status(worktree_path, base_commit, cli_opts)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git diff failed: {e}")))?;
        Ok(entries
            .into_iter()
            .map(|e| Self::status_entry_to_diff(&repo, &base_tree, e))
            .collect())
    }

    /// Returns file paths that differ from base commit, without loading content.
    /// Much cheaper than `get_diffs` — skips content loading (`status_entry_to_diff`),
    /// only runs git name-status commands to get the file list.
    pub fn get_diff_file_paths(
        &self,
        worktree_path: &Path,
        base_commit: &Commit,
    ) -> Result<HashSet<String>, GitServiceError> {
        let git = GitCli::new();
        let entries = git
            .diff_status(
                worktree_path,
                base_commit,
                cli::StatusDiffOptions { path_filter: None },
            )
            .map_err(|e| GitServiceError::InvalidRepository(format!("git diff failed: {e}")))?;
        Ok(entries.into_iter().map(|e| e.path).collect())
    }

    /// Extract file path from a Diff (for indexing and ConversationPatch)
    pub fn diff_path(diff: &Diff) -> String {
        diff.new_path
            .clone()
            .or_else(|| diff.old_path.clone())
            .unwrap_or_default()
    }

    /// Helper function to convert blob to string content
    fn blob_to_string(blob: &git2::Blob) -> Option<String> {
        if blob.is_binary() {
            None // Skip binary files
        } else {
            std::str::from_utf8(blob.content())
                .ok()
                .map(|s| s.to_string())
        }
    }

    /// Helper function to read file content from filesystem with safety guards
    fn read_file_to_string(repo: &Repository, rel_path: &Path) -> Option<String> {
        let workdir = repo.workdir()?;
        let abs_path = workdir.join(rel_path);

        // Read file from filesystem
        let bytes = match std::fs::read(&abs_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::debug!("Failed to read file from filesystem: {:?}: {}", abs_path, e);
                return None;
            }
        };

        // Size guard - skip files larger than UI inline threshold
        if bytes.len() > MAX_INLINE_DIFF_BYTES {
            tracing::debug!(
                "Skipping large file ({}KB): {:?}",
                bytes.len() / 1024,
                abs_path
            );
            return None;
        }

        // Binary guard - skip files containing null bytes
        if bytes.contains(&0) {
            tracing::debug!("Skipping binary file: {:?}", abs_path);
            return None;
        }

        // UTF-8 validation
        match String::from_utf8(bytes) {
            Ok(content) => Some(content),
            Err(e) => {
                tracing::debug!("File is not valid UTF-8: {:?}: {}", abs_path, e);
                None
            }
        }
    }

    /// Create Diff entries from git_cli::StatusDiffEntry
    /// New Diff format is flattened with change kind, paths, and optional contents.
    fn status_entry_to_diff(repo: &Repository, base_tree: &git2::Tree, e: StatusDiffEntry) -> Diff {
        // Map ChangeType to DiffChangeKind
        let mut change = match e.change {
            ChangeType::Added => DiffChangeKind::Added,
            ChangeType::Deleted => DiffChangeKind::Deleted,
            ChangeType::Modified => DiffChangeKind::Modified,
            ChangeType::Renamed => DiffChangeKind::Renamed,
            ChangeType::Copied => DiffChangeKind::Copied,
            // Treat type changes and unmerged as modified for now
            ChangeType::TypeChanged | ChangeType::Unmerged => DiffChangeKind::Modified,
            ChangeType::Unknown(_) => DiffChangeKind::Modified,
        };

        // Determine old/new paths based on change
        let (old_path_opt, new_path_opt): (Option<String>, Option<String>) = match e.change {
            ChangeType::Added => (None, Some(e.path.clone())),
            ChangeType::Deleted => (Some(e.old_path.unwrap_or(e.path.clone())), None),
            ChangeType::Modified | ChangeType::TypeChanged | ChangeType::Unmerged => (
                Some(e.old_path.unwrap_or(e.path.clone())),
                Some(e.path.clone()),
            ),
            ChangeType::Renamed | ChangeType::Copied => (e.old_path.clone(), Some(e.path.clone())),
            ChangeType::Unknown(_) => (e.old_path.clone(), Some(e.path.clone())),
        };

        // Decide if we should omit content by size (either side)
        let mut content_omitted = false;
        // Old side (from base tree)
        if let Some(ref oldp) = old_path_opt {
            let rel = std::path::Path::new(oldp);
            if let Ok(entry) = base_tree.get_path(rel)
                && entry.kind() == Some(git2::ObjectType::Blob)
                && let Ok(blob) = repo.find_blob(entry.id())
                && !blob.is_binary()
                && blob.size() > MAX_INLINE_DIFF_BYTES
            {
                content_omitted = true;
            }
        }
        // New side (from filesystem)
        if let Some(ref newp) = new_path_opt
            && let Some(workdir) = repo.workdir()
        {
            let abs = workdir.join(newp);
            if let Ok(md) = std::fs::metadata(&abs)
                && (md.len() as usize) > MAX_INLINE_DIFF_BYTES
            {
                content_omitted = true;
            }
        }

        // Load contents only if not omitted
        let (old_content, new_content) = if content_omitted {
            (None, None)
        } else {
            // Load old content from base tree if possible
            let old_content = if let Some(ref oldp) = old_path_opt {
                let rel = std::path::Path::new(oldp);
                match base_tree.get_path(rel) {
                    Ok(entry) if entry.kind() == Some(git2::ObjectType::Blob) => repo
                        .find_blob(entry.id())
                        .ok()
                        .and_then(|b| Self::blob_to_string(&b)),
                    _ => None,
                }
            } else {
                None
            };

            // Load new content from filesystem (worktree) when available
            let new_content = if let Some(ref newp) = new_path_opt {
                let rel = std::path::Path::new(newp);
                Self::read_file_to_string(repo, rel)
            } else {
                None
            };
            (old_content, new_content)
        };

        // If reported as Modified but content is identical, treat as a permission-only change
        if matches!(change, DiffChangeKind::Modified)
            && old_content.is_some()
            && new_content.is_some()
            && old_content == new_content
        {
            change = DiffChangeKind::PermissionChange;
        }

        // Compute line stats from available content
        let (additions, deletions) = match (&old_content, &new_content) {
            (Some(old), Some(new)) => {
                let (adds, dels) = compute_line_change_counts(old, new);
                (Some(adds), Some(dels))
            }
            (Some(old), None) => {
                // File deleted - all lines are deletions
                (Some(0), Some(old.lines().count()))
            }
            (None, Some(new)) => {
                // File added - all lines are additions
                (Some(new.lines().count()), Some(0))
            }
            (None, None) => (None, None),
        };

        Diff {
            change,
            old_path: old_path_opt,
            new_path: new_path_opt,
            old_content,
            new_content,
            content_omitted,
            additions,
            deletions,
            repo_id: None,
        }
    }

    /// Find where a branch is currently checked out
    fn find_checkout_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<std::path::PathBuf>, GitServiceError> {
        let git_cli = GitCli::new();
        let worktrees = git_cli.list_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree list failed: {e}"))
        })?;

        for worktree in worktrees {
            if let Some(ref branch) = worktree.branch
                && branch == branch_name
            {
                return Ok(Some(std::path::PathBuf::from(worktree.path)));
            }
        }
        Ok(None)
    }

    /// Merge changes from a task branch into the base branch.
    pub fn merge_changes(
        &self,
        base_worktree_path: &Path,
        task_worktree_path: &Path,
        task_branch_name: &str,
        base_branch_name: &str,
        commit_message: &str,
    ) -> Result<String, GitServiceError> {
        // Open the repositories
        let task_repo = self.open_repo(task_worktree_path)?;
        let base_repo = self.open_repo(base_worktree_path)?;

        // Check if base branch is ahead of task branch - this indicates the base has moved
        // ahead since the task was created, which should block the merge
        let (_, task_behind) =
            self.get_branch_status(base_worktree_path, task_branch_name, base_branch_name)?;

        if task_behind > 0 {
            return Err(GitServiceError::BranchesDiverged(format!(
                "Cannot merge: base branch '{base_branch_name}' is {task_behind} commits ahead of task branch '{task_branch_name}'. The base branch has moved forward since the task was created.",
            )));
        }

        // Check where base branch is checked out (if anywhere)
        match self.find_checkout_path_for_branch(base_worktree_path, base_branch_name)? {
            Some(base_checkout_path) => {
                // base branch is checked out somewhere - use CLI merge
                let git_cli = GitCli::new();

                // Safety check: base branch has no staged changes
                if git_cli
                    .has_staged_changes(&base_checkout_path)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git diff --cached failed: {e}"))
                    })?
                {
                    return Err(GitServiceError::WorktreeDirty(
                        base_branch_name.to_string(),
                        "staged changes present".to_string(),
                    ));
                }

                // Use CLI merge in base context
                self.ensure_cli_commit_identity(&base_checkout_path)?;
                let sha = git_cli
                    .merge_squash_commit(
                        &base_checkout_path,
                        base_branch_name,
                        task_branch_name,
                        commit_message,
                    )
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("CLI merge failed: {e}"))
                    })?;

                // Update task branch ref for continuity
                let task_refname = format!("refs/heads/{task_branch_name}");
                git_cli
                    .update_ref(base_worktree_path, &task_refname, &sha)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git update-ref failed: {e}"))
                    })?;

                Ok(sha)
            }
            None => {
                // base branch not checked out anywhere - use libgit2 pure ref operations
                let task_branch = Self::find_branch(&task_repo, task_branch_name)?;
                let base_branch = Self::find_branch(&task_repo, base_branch_name)?;

                // Resolve commits
                let base_commit = base_branch.get().peel_to_commit()?;
                let task_commit = task_branch.get().peel_to_commit()?;

                // Create the squash commit in-memory (no checkout) and update the base branch ref
                let signature = self.signature_with_fallback(&task_repo)?;
                let squash_commit_id = self.perform_squash_merge(
                    &task_repo,
                    &base_commit,
                    &task_commit,
                    &signature,
                    commit_message,
                    base_branch_name,
                )?;

                // Update the task branch to the new squash commit so follow-up
                // work can continue from the merged state without conflicts.
                let task_refname = format!("refs/heads/{task_branch_name}");
                base_repo.reference(
                    &task_refname,
                    squash_commit_id,
                    true,
                    "Reset task branch after squash merge",
                )?;

                Ok(squash_commit_id.to_string())
            }
        }
    }
    fn get_branch_status_inner(
        &self,
        repo: &Repository,
        branch_ref: &Reference,
        base_branch_ref: &Reference,
    ) -> Result<(usize, usize), GitServiceError> {
        let (a, b) = repo.graph_ahead_behind(
            branch_ref.target().ok_or(GitServiceError::BranchNotFound(
                "Branch not found".to_string(),
            ))?,
            base_branch_ref
                .target()
                .ok_or(GitServiceError::BranchNotFound(
                    "Branch not found".to_string(),
                ))?,
        )?;
        Ok((a, b))
    }

    pub fn get_branch_status(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;
        self.get_branch_status_inner(
            &repo,
            &branch.into_reference(),
            &base_branch.into_reference(),
        )
    }

    pub fn get_base_commit(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<Commit, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;
        // Find the common ancestor (merge base)
        let oid = repo
            .merge_base(
                branch.get().peel_to_commit()?.id(),
                base_branch.get().peel_to_commit()?.id(),
            )
            .map_err(GitServiceError::from)?;
        Ok(Commit::new(oid))
    }

    pub fn get_remote_branch_status(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: Option<&str>,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch_ref = Self::find_branch(&repo, branch_name)?.into_reference();
        // base branch is either given or upstream of branch_name
        let base_branch_ref = if let Some(bn) = base_branch_name {
            Self::find_branch(&repo, bn)?
        } else {
            repo.find_branch(branch_name, BranchType::Local)?
                .upstream()?
        }
        .into_reference();
        let remote = self.get_remote_from_branch_ref(&repo, &base_branch_ref)?;
        self.fetch_all_from_remote(&repo, &remote)?;
        self.get_branch_status_inner(&repo, &branch_ref, &base_branch_ref)
    }

    pub fn is_worktree_clean(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        match self.check_worktree_clean(&repo) {
            Ok(()) => Ok(true),
            Err(GitServiceError::WorktreeDirty(_, _)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Check if the worktree is clean (no uncommitted changes to tracked files)
    fn check_worktree_clean(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let mut status_options = git2::StatusOptions::new();
        status_options
            .include_untracked(false) // Don't include untracked files
            .include_ignored(false); // Don't include ignored files

        let statuses = repo.statuses(Some(&mut status_options))?;

        if !statuses.is_empty() {
            let mut dirty_files = Vec::new();
            for entry in statuses.iter() {
                let status = entry.status();
                // Only consider files that are actually tracked and modified
                if status.intersects(
                    git2::Status::INDEX_MODIFIED
                        | git2::Status::INDEX_NEW
                        | git2::Status::INDEX_DELETED
                        | git2::Status::INDEX_RENAMED
                        | git2::Status::INDEX_TYPECHANGE
                        | git2::Status::WT_MODIFIED
                        | git2::Status::WT_DELETED
                        | git2::Status::WT_RENAMED
                        | git2::Status::WT_TYPECHANGE,
                ) && let Some(path) = entry.path()
                {
                    dirty_files.push(path.to_string());
                }
            }

            if !dirty_files.is_empty() {
                let branch_name = repo
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown branch".to_string());
                return Err(GitServiceError::WorktreeDirty(
                    branch_name,
                    dirty_files.join(", "),
                ));
            }
        }

        Ok(())
    }

    /// Get the HEAD commit OID for a repo/worktree. Returns None if HEAD is unborn.
    pub fn get_head_commit(&self, repo_path: &Path) -> Option<Commit> {
        let repo = self.open_repo(repo_path).ok()?;
        let head = repo.head().ok()?;
        head.target().map(Commit::new)
    }

    /// Returns true if HEAD's first parent is `expected_parent_oid` (i.e., HEAD is a simple commit on top of it).
    pub fn is_head_child_of(&self, repo_path: &Path, expected_parent_oid: git2::Oid) -> bool {
        let check = || -> Option<bool> {
            let repo = self.open_repo(repo_path).ok()?;
            let oid = repo.head().ok()?.target()?;
            let parent = repo.find_commit(oid).ok()?.parent(0).ok()?;
            Some(parent.id() == expected_parent_oid)
        };
        check().unwrap_or(false)
    }

    /// Get current HEAD information including branch name and commit OID
    pub fn get_head_info(&self, repo_path: &Path) -> Result<HeadInfo, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let head = repo.head()?;

        let branch = if let Some(branch_name) = head.shorthand() {
            branch_name.to_string()
        } else {
            "HEAD".to_string()
        };

        let oid = if let Some(target_oid) = head.target() {
            target_oid.to_string()
        } else {
            // Handle case where HEAD exists but has no target (empty repo)
            return Err(GitServiceError::InvalidRepository(
                "Repository HEAD has no target commit".to_string(),
            ));
        };

        Ok(HeadInfo { branch, oid })
    }

    pub fn get_current_branch(&self, repo_path: &Path) -> Result<String, GitServiceError> {
        Ok(self.get_head_info(repo_path)?.branch)
    }

    /// Detect the remote's default branch from refs/remotes/origin/HEAD.
    /// Returns None if the reference doesn't exist or isn't a symbolic ref.
    pub fn get_remote_default_branch(&self, repo_path: &Path) -> Option<String> {
        let repo = self.open_repo(repo_path).ok()?;
        let reference = repo.find_reference("refs/remotes/origin/HEAD").ok()?;
        let target = reference.symbolic_target()?;
        target
            .strip_prefix("refs/remotes/origin/")
            .map(|s| s.to_string())
    }

    /// Get the commit OID (as hex string) for a given branch without modifying HEAD
    pub fn get_branch_oid(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let oid = branch.get().peel_to_commit()?.id().to_string();
        Ok(oid)
    }

    pub fn get_fork_point(
        &self,
        worktree_path: &Path,
        target_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
        let git = GitCli::new();
        Ok(git.merge_base(worktree_path, target_branch, task_branch)?)
    }

    /// Return the full worktree status including all entries
    pub fn get_worktree_status(
        &self,
        worktree_path: &Path,
    ) -> Result<WorktreeStatus, GitServiceError> {
        let cli = GitCli::new();
        cli.get_worktree_status(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))
    }

    /// Return (uncommitted_tracked_changes, untracked_files) counts in worktree
    pub fn get_worktree_change_counts(
        &self,
        worktree_path: &Path,
    ) -> Result<(usize, usize), GitServiceError> {
        let st = self.get_worktree_status(worktree_path)?;
        Ok((st.uncommitted_tracked, st.untracked))
    }

    /// Evaluate whether any action is needed to reset to `target_commit_oid` and
    /// optionally perform the actions.
    pub fn reconcile_worktree_to_commit(
        &self,
        worktree_path: &Path,
        target_commit_oid: &str,
        options: WorktreeResetOptions,
    ) -> WorktreeResetOutcome {
        let WorktreeResetOptions {
            perform_reset,
            force_when_dirty,
            is_dirty,
            log_skip_when_dirty,
        } = options;

        let head_oid = self.get_head_info(worktree_path).ok().map(|h| h.oid);
        let mut outcome = WorktreeResetOutcome::default();

        if head_oid.as_deref() != Some(target_commit_oid) || is_dirty {
            outcome.needed = true;

            if perform_reset {
                if is_dirty && !force_when_dirty {
                    if log_skip_when_dirty {
                        tracing::warn!("Worktree dirty; skipping reset as not forced");
                    }
                } else if let Err(e) = self.reset_worktree_to_commit(
                    worktree_path,
                    target_commit_oid,
                    force_when_dirty,
                ) {
                    tracing::error!("Failed to reset worktree: {}", e);
                } else {
                    outcome.applied = true;
                }
            }
        }

        outcome
    }

    /// Reset the given worktree to the specified commit SHA.
    /// If `force` is false and the worktree is dirty, returns WorktreeDirty error.
    pub fn reset_worktree_to_commit(
        &self,
        worktree_path: &Path,
        commit_sha: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        if !force {
            // Avoid clobbering uncommitted changes unless explicitly forced
            self.check_worktree_clean(&repo)?;
        }
        let cli = GitCli::new();
        cli.git(worktree_path, ["reset", "--hard", commit_sha])
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("git reset --hard failed: {e}"))
            })?;
        if force {
            cli.git(worktree_path, ["clean", "-fd"]).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git clean -fd failed: {e}"))
            })?;
        }
        // Reapply sparse-checkout if configured (non-fatal)
        let _ = cli.git(worktree_path, ["sparse-checkout", "reapply"]);
        Ok(())
    }

    /// Add a worktree for a branch, optionally creating the branch
    pub fn add_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
        create_branch: bool,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_add(repo_path, worktree_path, branch, create_branch)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    /// Remove a worktree
    pub fn remove_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_remove(repo_path, worktree_path, force)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    /// Move a worktree to a new location
    pub fn move_worktree(
        &self,
        repo_path: &Path,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_move(repo_path, old_path, new_path)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    pub fn prune_worktrees(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_prune(repo_path)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    pub fn delete_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.delete_branch(repo_path, branch_name)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    pub fn get_all_branches(&self, repo_path: &Path) -> Result<Vec<GitBranch>, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let current_branch = self.get_current_branch(repo_path).unwrap_or_default();
        let mut branches = Vec::new();

        // Helper function to get last commit date for a branch
        let get_last_commit_date = |branch: &git2::Branch| -> Result<DateTime<Utc>, git2::Error> {
            if let Some(target) = branch.get().target()
                && let Ok(commit) = repo.find_commit(target)
            {
                let timestamp = commit.time().seconds();
                return Ok(DateTime::from_timestamp(timestamp, 0).unwrap_or_else(Utc::now));
            }
            Ok(Utc::now()) // Default to now if we can't get the commit date
        };

        // Get local branches
        let local_branches = repo.branches(Some(BranchType::Local))?;
        for branch_result in local_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                let last_commit_date = get_last_commit_date(&branch)?;
                branches.push(GitBranch {
                    name: name.to_string(),
                    is_current: name == current_branch,
                    is_remote: false,
                    last_commit_date,
                });
            }
        }

        // Get remote branches
        let remote_branches = repo.branches(Some(BranchType::Remote))?;
        for branch_result in remote_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                // Skip remote HEAD references
                if !name.ends_with("/HEAD") {
                    let last_commit_date = get_last_commit_date(&branch)?;
                    branches.push(GitBranch {
                        name: name.to_string(),
                        is_current: false,
                        is_remote: true,
                        last_commit_date,
                    });
                }
            }
        }

        // Sort branches: current first, then by most recent commit date
        branches.sort_by(|a, b| {
            if a.is_current && !b.is_current {
                std::cmp::Ordering::Less
            } else if !a.is_current && b.is_current {
                std::cmp::Ordering::Greater
            } else {
                // Sort by most recent commit date (newest first)
                b.last_commit_date.cmp(&a.last_commit_date)
            }
        });

        Ok(branches)
    }

    /// Perform a squash merge of task branch into base branch, but fail on conflicts
    fn perform_squash_merge(
        &self,
        repo: &Repository,
        base_commit: &git2::Commit,
        task_commit: &git2::Commit,
        signature: &git2::Signature,
        commit_message: &str,
        base_branch_name: &str,
    ) -> Result<git2::Oid, GitServiceError> {
        // In-memory merge to detect conflicts without touching the working tree
        let mut merge_opts = git2::MergeOptions::new();
        // Safety and correctness options
        merge_opts.find_renames(true); // improve rename handling
        merge_opts.fail_on_conflict(true); // bail out instead of generating conflicted index
        let mut index = repo.merge_commits(base_commit, task_commit, Some(&merge_opts))?;

        // If there are conflicts, return an error
        if index.has_conflicts() {
            return Err(GitServiceError::MergeConflicts {
                message: "Merge failed due to conflicts. Please resolve conflicts manually."
                    .to_string(),
                conflicted_files: vec![],
            });
        }

        // Write the merged tree back to the repository
        let tree_id = index.write_tree_to(repo)?;
        let tree = repo.find_tree(tree_id)?;

        // Create a squash commit: use merged tree with base_commit as sole parent
        let squash_commit_id = repo.commit(
            None,           // Don't update any reference yet
            signature,      // Author
            signature,      // Committer
            commit_message, // Custom message
            &tree,          // Merged tree content
            &[base_commit], // Single parent: base branch commit
        )?;

        // Update the base branch reference to point to the new commit
        let refname = format!("refs/heads/{base_branch_name}");
        repo.reference(&refname, squash_commit_id, true, "Squash merge")?;

        Ok(squash_commit_id)
    }

    /// Rebase a worktree branch onto a new base
    pub fn rebase_branch(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        new_base_branch: &str,
        old_base_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
        let worktree_repo = Repository::open(worktree_path)?;
        let main_repo = self.open_repo(repo_path)?;

        // Safety guard: never operate on a dirty worktree. This preserves any
        // uncommitted changes to tracked files by failing fast instead of
        // resetting or cherry-picking over them. Untracked files are allowed.
        self.check_worktree_clean(&worktree_repo)?;

        // If a rebase is already in progress, refuse to proceed instead of
        // aborting (which might destroy user changes mid-rebase).
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        // Get the target base branch reference
        let nbr = Self::find_branch(&main_repo, new_base_branch)?.into_reference();
        // If the target base is remote, update it first so CLI sees latest
        if nbr.is_remote() {
            self.fetch_branch_from_remote(&main_repo, &nbr)?;
        }

        // Ensure identity for any commits produced by rebase
        self.ensure_cli_commit_identity(worktree_path)?;
        // Use git CLI rebase to carry out the operation safely
        match git.rebase_onto(worktree_path, new_base_branch, old_base_branch, task_branch) {
            Ok(()) => {}
            Err(GitCliError::RebaseInProgress) => {
                return Err(GitServiceError::RebaseInProgress);
            }
            Err(GitCliError::CommandFailed(stderr)) => {
                // If the CLI indicates conflicts, return a concise, actionable error.
                let looks_like_conflict = stderr.contains("could not apply")
                    || stderr.contains("CONFLICT")
                    || stderr.to_lowercase().contains("resolve all conflicts");
                if looks_like_conflict {
                    // Determine current attempt branch name for clarity
                    let attempt_branch = worktree_repo
                        .head()
                        .ok()
                        .and_then(|h| h.shorthand().map(|s| s.to_string()))
                        .unwrap_or_else(|| "(unknown)".to_string());
                    // List conflicted files (best-effort)
                    let conflicted_files =
                        git.get_conflicted_files(worktree_path).unwrap_or_default();
                    let files_part = if conflicted_files.is_empty() {
                        "".to_string()
                    } else {
                        let mut sample = conflicted_files.clone();
                        let total = sample.len();
                        sample.truncate(10);
                        let list = sample.join(", ");
                        if total > sample.len() {
                            format!(
                                " Conflicted files (showing {} of {}): {}.",
                                sample.len(),
                                total,
                                list
                            )
                        } else {
                            format!(" Conflicted files: {list}.")
                        }
                    };
                    let msg = format!(
                        "Rebase encountered merge conflicts while rebasing '{attempt_branch}' onto '{new_base_branch}'.{files_part} Resolve conflicts and then continue or abort."
                    );
                    return Err(GitServiceError::MergeConflicts {
                        message: msg,
                        conflicted_files,
                    });
                }
                return Err(GitServiceError::InvalidRepository(format!(
                    "Rebase failed: {}",
                    stderr.lines().next().unwrap_or("")
                )));
            }
            Err(e) => {
                return Err(GitServiceError::InvalidRepository(format!(
                    "git rebase failed: {e}"
                )));
            }
        }

        // Return resulting HEAD commit
        let final_commit = worktree_repo.head()?.peel_to_commit()?;
        Ok(final_commit.id().to_string())
    }

    /// Returns true if the branch is a remote-tracking branch (not local).
    pub fn is_remote_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(_) => Ok(false),
            Err(_) => match repo.find_branch(branch_name, BranchType::Remote) {
                Ok(_) => Ok(true),
                Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
            },
        }
    }

    pub fn check_branch_exists(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(_) => Ok(true),
            Err(_) => match repo.find_branch(branch_name, BranchType::Remote) {
                Ok(_) => Ok(true),
                Err(_) => Ok(false),
            },
        }
    }

    pub fn rename_local_branch(
        &self,
        worktree_path: &Path,
        old_branch_name: &str,
        new_branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(worktree_path)?;

        let mut branch = repo
            .find_branch(old_branch_name, BranchType::Local)
            .map_err(|_| GitServiceError::BranchNotFound(old_branch_name.to_string()))?;

        branch.rename(new_branch_name, false)?;

        repo.set_head(&format!("refs/heads/{new_branch_name}"))?;

        Ok(())
    }

    /// Return true if a rebase is currently in progress in this worktree.
    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let git = GitCli::new();
        git.is_rebase_in_progress(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase state check failed: {e}"))
        })
    }

    pub fn detect_conflict_op(
        &self,
        worktree_path: &Path,
    ) -> Result<Option<ConflictOp>, GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Rebase));
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Merge));
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return Ok(Some(ConflictOp::CherryPick));
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Revert));
        }
        Ok(None)
    }

    /// List conflicted (unmerged) files in the worktree.
    pub fn get_conflicted_files(
        &self,
        worktree_path: &Path,
    ) -> Result<Vec<String>, GitServiceError> {
        let git = GitCli::new();
        git.get_conflicted_files(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git diff for conflicts failed: {e}"))
        })
    }

    /// Abort an in-progress rebase in this worktree (no-op if none).
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.abort_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --abort failed: {e}"))
        })
    }

    /// Continue an in-progress rebase. Fails if there are unresolved conflicts.
    pub fn continue_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.continue_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --continue failed: {e}"))
        })
    }

    pub fn abort_conflicts(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            // If there are no conflicted files, prefer `git rebase --quit` to clean up metadata
            let has_conflicts = !self
                .get_conflicted_files(worktree_path)
                .unwrap_or_default()
                .is_empty();
            if has_conflicts {
                return self.abort_rebase(worktree_path);
            } else {
                return git.quit_rebase(worktree_path).map_err(|e| {
                    GitServiceError::InvalidRepository(format!("git rebase --quit failed: {e}"))
                });
            }
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_merge(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git merge --abort failed: {e}"))
            });
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return git.abort_cherry_pick(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git cherry-pick --abort failed: {e}"))
            });
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_revert(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git revert --abort failed: {e}"))
            });
        }
        Ok(())
    }

    pub(crate) fn find_branch<'a>(
        repo: &'a Repository,
        branch_name: &str,
    ) -> Result<git2::Branch<'a>, GitServiceError> {
        // Try to find the branch as a local branch first
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(branch) => Ok(branch),
            Err(_) => {
                // If not found, try to find it as a remote branch
                match repo.find_branch(branch_name, BranchType::Remote) {
                    Ok(branch) => Ok(branch),
                    Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
                }
            }
        }
    }

    pub fn get_remote_from_branch_name(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<GitRemote, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch_ref = Self::find_branch(&repo, branch_name)?.into_reference();
        let remote = self.get_remote_from_branch_ref(&repo, &branch_ref)?;
        let name = remote.name().map(|name| name.to_string()).ok_or_else(|| {
            GitServiceError::InvalidRepository(format!(
                "Remote for branch '{branch_name}' has no name"
            ))
        })?;
        let url = remote.url().map(|url| url.to_string()).ok_or_else(|| {
            GitServiceError::InvalidRepository(format!(
                "Remote for branch '{branch_name}' has no URL"
            ))
        })?;
        Ok(GitRemote { name, url })
    }

    pub fn get_remote_url(
        &self,
        repo_path: &Path,
        remote_name: &str,
    ) -> Result<String, GitServiceError> {
        let cli = GitCli::new();
        cli.get_remote_url(repo_path, remote_name)
            .map_err(GitServiceError::from)
    }

    pub fn get_default_remote(&self, repo_path: &Path) -> Result<GitRemote, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        self.default_remote(&repo, repo_path)
    }

    pub fn list_remotes(&self, repo_path: &Path) -> Result<Vec<GitRemote>, GitServiceError> {
        let cli = GitCli::new();
        let remotes = cli.list_remotes(repo_path)?;

        Ok(remotes
            .into_iter()
            .map(|(name, url)| GitRemote { name, url })
            .collect())
    }

    pub fn check_remote_branch_exists(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<bool, GitServiceError> {
        let git_cli = GitCli::new();
        git_cli
            .check_remote_branch_exists(repo_path, remote_url, branch_name)
            .map_err(GitServiceError::from)
    }

    pub fn resolve_remote_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<GitRemote, GitServiceError> {
        self.get_remote_from_branch_name(repo_path, branch_name)
            .or_else(|_| self.get_default_remote(repo_path))
    }

    fn get_remote_from_branch_ref<'a>(
        &self,
        repo: &'a Repository,
        branch_ref: &Reference,
    ) -> Result<Remote<'a>, GitServiceError> {
        let branch_name = branch_ref
            .name()
            .map(|name| name.to_string())
            .ok_or_else(|| GitServiceError::InvalidRepository("Invalid branch ref".into()))?;
        let remote_name_buf = repo.branch_remote_name(&branch_name)?;

        let remote_name = str::from_utf8(&remote_name_buf)
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!(
                    "Invalid remote name for branch {branch_name}: {e}"
                ))
            })?
            .to_string();
        repo.find_remote(&remote_name).map_err(|_| {
            GitServiceError::InvalidRepository(format!(
                "Remote '{remote_name}' for branch '{branch_name}' not found"
            ))
        })
    }

    pub fn push_to_remote(
        &self,
        worktree_path: &Path,
        branch_name: &str,
        remote_branch_name: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        self.push_to_remote_with_token(worktree_path, branch_name, remote_branch_name, force, None)
    }

    /// Same as [`push_to_remote`], but authenticates with the given PAT
    /// instead of the machine's git credential helper. Pass `None` to
    /// preserve the historical behaviour.
    ///
    /// `remote_branch_name` is the ref the push updates on the remote. It
    /// only differs from `branch_name` for workspaces created from an
    /// existing PR (unique local branch, PR head branch on the remote).
    pub fn push_to_remote_with_token(
        &self,
        worktree_path: &Path,
        branch_name: &str,
        remote_branch_name: &str,
        force: bool,
        token: Option<&str>,
    ) -> Result<(), GitServiceError> {
        let repo = Repository::open(worktree_path)?;
        self.check_worktree_clean(&repo)?;

        // Get the remote
        let remote = self.default_remote(&repo, worktree_path)?;

        let git_cli = GitCli::new();
        if let Err(e) = git_cli.push_with_token(
            worktree_path,
            &remote.url,
            branch_name,
            remote_branch_name,
            force,
            token,
        ) {
            tracing::error!("Push to remote failed: {}", e);
            return Err(e.into());
        }

        // Best-effort bookkeeping: the push itself succeeded, so failures
        // updating the tracking ref or upstream config (e.g. a narrow
        // remote.<name>.fetch refspec that doesn't cover this branch) must
        // not report the push as failed.
        if let Err(e) =
            Self::update_tracking_after_push(&repo, branch_name, &remote.name, remote_branch_name)
        {
            tracing::warn!(
                "Pushed '{branch_name}' but could not update tracking ref/upstream: {e}"
            );
        }

        Ok(())
    }

    fn update_tracking_after_push(
        repo: &Repository,
        branch_name: &str,
        remote_name: &str,
        remote_branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let mut branch = Self::find_branch(repo, branch_name)?;
        if !branch.get().is_remote() {
            if let Some(branch_target) = branch.get().target() {
                let remote_ref = format!("refs/remotes/{remote_name}/{remote_branch_name}");
                repo.reference(
                    &remote_ref,
                    branch_target,
                    true,
                    "update remote tracking branch",
                )?;
            }
            branch.set_upstream(Some(&format!("{remote_name}/{remote_branch_name}")))?;
        }
        Ok(())
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_from_remote(
        &self,
        repo: &Repository,
        remote: &Remote,
        refspec: &str,
    ) -> Result<(), GitServiceError> {
        // Get the remote
        let remote_url = remote
            .url()
            .ok_or_else(|| GitServiceError::InvalidRepository("Remote has no URL".to_string()))?;

        let git_cli = GitCli::new();
        if let Err(e) = git_cli.fetch_with_refspec(repo.path(), remote_url, refspec) {
            tracing::error!("Fetch from GitHub failed: {}", e);
            return Err(e.into());
        }
        Ok(())
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_branch_from_remote(
        &self,
        repo: &Repository,
        branch: &Reference,
    ) -> Result<(), GitServiceError> {
        let remote = self.get_remote_from_branch_ref(repo, branch)?;
        let default_remote = self.default_remote(repo, repo.path())?;
        let remote_name = remote.name().unwrap_or(&default_remote.name);
        let dest_ref = branch
            .name()
            .ok_or_else(|| GitServiceError::InvalidRepository("Invalid branch ref".into()))?;
        let remote_prefix = format!("refs/remotes/{remote_name}/");
        let src_ref = dest_ref.replacen(&remote_prefix, "refs/heads/", 1);
        let refspec = format!("+{src_ref}:{dest_ref}");
        self.fetch_from_remote(repo, &remote, &refspec)
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_all_from_remote(
        &self,
        repo: &Repository,
        remote: &Remote,
    ) -> Result<(), GitServiceError> {
        let default_remote = self.default_remote(repo, repo.path())?;
        let remote_name = remote.name().unwrap_or(&default_remote.name);
        let refspec = format!("+refs/heads/*:refs/remotes/{remote_name}/*");
        self.fetch_from_remote(repo, remote, &refspec)
    }

    /// Fetch the named branch from the default remote and fast-forward the
    /// local branch ref if possible. Returns the ref name to use as the base
    /// for new workspace branches.
    ///
    /// Outcomes:
    /// - Fetch succeeds + local can be fast-forwarded → advances local branch,
    ///   returns `branch_name` (now up to date).
    /// - Fetch succeeds + local has diverged → warns, returns
    ///   `<remote>/<branch_name>` so the workspace starts from the authoritative
    ///   remote tip instead of the stale local ref.
    /// - Local branch is absent → returns `<remote>/<branch_name>` (handles
    ///   the missing-local-branch case, issue #36).
    /// - Fetch fails (no network, auth error, etc.) → warns, returns
    ///   `branch_name` unchanged so workspace creation can still proceed.
    pub fn fetch_and_update_target_branch(&self, repo_path: &Path, branch_name: &str) -> String {
        let remote = match self.get_default_remote(repo_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    "fetch target '{}': no remote for {:?}: {}",
                    branch_name,
                    repo_path,
                    e
                );
                return branch_name.to_string();
            }
        };

        let refspec = format!(
            "+refs/heads/{branch_name}:refs/remotes/{}/{branch_name}",
            remote.name
        );
        let cli = GitCli::new();
        if let Err(e) = cli.fetch_with_refspec(repo_path, &remote.url, &refspec) {
            tracing::warn!(
                "fetch target '{}' from '{}' failed: {}. Using local ref (possibly stale).",
                branch_name,
                remote.url,
                e
            );
            return branch_name.to_string();
        }

        let remote_ref = format!("{}/{}", remote.name, branch_name);

        let repo = match self.open_repo(repo_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    "fetch target '{}': could not reopen repo after fetch: {}. Using '{}'.",
                    branch_name,
                    e,
                    remote_ref
                );
                return remote_ref;
            }
        };

        let remote_oid = match repo
            .find_branch(&remote_ref, BranchType::Remote)
            .ok()
            .and_then(|b| b.get().target())
        {
            Some(oid) => oid,
            None => {
                tracing::warn!(
                    "fetch target '{}': remote ref '{}' missing after fetch. Using local ref.",
                    branch_name,
                    remote_ref
                );
                return branch_name.to_string();
            }
        };

        // Local branch absent → use remote tracking ref directly (issue #36).
        let local_oid = match repo
            .find_branch(branch_name, BranchType::Local)
            .ok()
            .and_then(|b| b.get().target())
        {
            Some(oid) => oid,
            None => {
                tracing::info!(
                    "fetch target '{}': local branch absent; using '{}' as workspace base.",
                    branch_name,
                    remote_ref
                );
                return remote_ref;
            }
        };

        if local_oid == remote_oid {
            return branch_name.to_string();
        }

        // Fast-forward is possible when remote_oid is a descendant of local_oid.
        if repo
            .graph_descendant_of(remote_oid, local_oid)
            .unwrap_or(false)
        {
            match repo.reference(
                &format!("refs/heads/{branch_name}"),
                remote_oid,
                true,
                "fast-forward before workspace creation",
            ) {
                Ok(_) => {
                    tracing::info!(
                        "fetch target '{}': fast-forwarded to {} (remote tip).",
                        branch_name,
                        &remote_oid.to_string()[..8]
                    );
                    branch_name.to_string()
                }
                Err(e) => {
                    tracing::warn!(
                        "fetch target '{}': fast-forward failed: {}. Using '{}'.",
                        branch_name,
                        e,
                        remote_ref
                    );
                    remote_ref
                }
            }
        } else {
            tracing::warn!(
                "fetch target '{}': local has diverged from remote; using '{}' as workspace base.",
                branch_name,
                remote_ref
            );
            remote_ref
        }
    }

    /// Clone a repository to the specified directory
    #[cfg(feature = "cloud")]
    pub fn clone_repository(
        clone_url: &str,
        target_path: &Path,
        token: Option<&str>,
    ) -> Result<Repository, GitServiceError> {
        use git2::{Cred, FetchOptions, RemoteCallbacks};

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Set up callbacks for authentication if token is provided
        let mut callbacks = RemoteCallbacks::new();
        if let Some(token) = token {
            callbacks.credentials(|_url, username_from_url, _allowed_types| {
                Cred::userpass_plaintext(username_from_url.unwrap_or("git"), token)
            });
        } else {
            // Fallback to SSH agent and key file authentication
            callbacks.credentials(|_url, username_from_url, _| {
                // Try SSH agent first
                if let Some(username) = username_from_url
                    && let Ok(cred) = Cred::ssh_key_from_agent(username)
                {
                    return Ok(cred);
                }

                // Fallback to key file (~/.ssh/id_rsa)
                let home = dirs::home_dir()
                    .ok_or_else(|| git2::Error::from_str("Could not find home directory"))?;
                let key_path = home.join(".ssh").join("id_rsa");
                Cred::ssh_key(username_from_url.unwrap_or("git"), None, &key_path, None)
            });
        }

        // Set up fetch options with our callbacks
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

        // Create a repository builder with fetch options
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);

        let repo = builder.clone(clone_url, target_path)?;

        tracing::info!(
            "Successfully cloned repository from {} to {}",
            clone_url,
            target_path.display()
        );

        Ok(repo)
    }

    /// Collect file statistics from recent commits for ranking purposes
    pub fn collect_recent_file_stats(
        &self,
        repo_path: &Path,
        commit_limit: usize,
    ) -> Result<HashMap<String, FileStat>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut stats: HashMap<String, FileStat> = HashMap::new();

        // Set up revision walk from HEAD
        let mut revwalk = repo.revwalk()?;
        revwalk.push_head()?;
        revwalk.set_sorting(Sort::TIME)?;

        // Iterate through recent commits
        for (commit_index, oid_result) in revwalk.take(commit_limit).enumerate() {
            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;

            // Get commit timestamp
            let commit_time = {
                let time = commit.time();
                DateTime::from_timestamp(time.seconds(), 0).unwrap_or_else(Utc::now)
            };

            // Get the commit tree
            let commit_tree = commit.tree()?;

            // For the first commit (no parent), diff against empty tree
            let parent_tree = if commit.parent_count() == 0 {
                None
            } else {
                Some(commit.parent(0)?.tree()?)
            };

            // Create diff between parent and current commit
            let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;

            // Process each changed file in this commit
            diff.foreach(
                &mut |delta, _progress| {
                    // Get the file path - prefer new file path, fall back to old
                    if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path())
                    {
                        let path_str = path.to_string_lossy().to_string();

                        // Update or insert file stats
                        let stat = stats.entry(path_str).or_insert(FileStat {
                            last_index: commit_index,
                            commit_count: 0,
                            last_time: commit_time,
                        });

                        // Increment commit count
                        stat.commit_count += 1;

                        // Keep the most recent change (smallest index)
                        if commit_index < stat.last_index {
                            stat.last_index = commit_index;
                            stat.last_time = commit_time;
                        }
                    }

                    true // Continue iteration
                },
                None, // No binary callback
                None, // No hunk callback
                None, // No line callback
            )?;
        }

        Ok(stats)
    }

    /// All tags with their target commit (annotated tags peeled), in plain
    /// `git tag` order (lexicographic). Mirrored inline in the client.
    pub fn get_all_tags(&self, repo_path: &Path) -> Result<Vec<GitTagInfo>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let names = repo.tag_names(None)?;
        let mut tags = Vec::new();
        for name in names.iter().flatten() {
            let refname = format!("refs/tags/{name}");
            if let Ok(reference) = repo.find_reference(&refname)
                && let Ok(commit) = reference.peel_to_commit()
            {
                tags.push(GitTagInfo {
                    name: name.to_string(),
                    target_oid: commit.id().to_string(),
                });
            }
        }
        Ok(tags)
    }

    /// Create a local branch pointing at an arbitrary commit (graph inline
    /// action). Fails if the name is taken or invalid.
    pub fn create_branch_at(
        &self,
        repo_path: &Path,
        name: &str,
        oid_str: &str,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let commit = repo.find_commit(git2::Oid::from_str(oid_str)?)?;
        repo.branch(name, &commit, false)?;
        Ok(())
    }

    /// Directory listing at a commit (read-only tree browsing for the
    /// embedded editor). Empty `rel_path` lists the root.
    pub fn get_commit_tree(
        &self,
        repo_path: &Path,
        oid_str: &str,
        rel_path: &str,
    ) -> Result<Vec<CommitTreeEntry>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let oid = git2::Oid::from_str(oid_str)?;
        let root = repo.find_commit(oid)?.tree()?;
        let tree = if rel_path.is_empty() {
            root
        } else {
            root.get_path(Path::new(rel_path))?
                .to_object(&repo)?
                .into_tree()
                .map_err(|_| {
                    GitServiceError::InvalidRepository("Not a directory".to_string())
                })?
        };
        let mut entries: Vec<CommitTreeEntry> = tree
            .iter()
            .filter_map(|entry| {
                let name = entry.name()?.to_string();
                Some(CommitTreeEntry {
                    is_directory: entry.kind() == Some(git2::ObjectType::Tree),
                    name,
                })
            })
            .collect();
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(entries)
    }

    /// Unified diff of a single file in a commit (vs its first parent), as
    /// a plain patch string for the editor's diff tabs.
    pub fn get_commit_file_diff(
        &self,
        repo_path: &Path,
        oid_str: &str,
        rel_path: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let oid = git2::Oid::from_str(oid_str)?;
        let commit = repo.find_commit(oid)?;
        let parent_tree = match commit.parent(0) {
            Ok(parent) => Some(parent.tree()?),
            Err(_) => None,
        };
        let mut opts = DiffOptions::new();
        opts.pathspec(rel_path);
        let diff = repo.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&commit.tree()?),
            Some(&mut opts),
        )?;
        let patch = match git2::Patch::from_diff(&diff, 0)? {
            Some(mut patch) => patch.to_buf()?.as_str().unwrap_or_default().to_string(),
            None => String::new(),
        };
        Ok(patch)
    }

    /// UTF-8 content of a file at a given commit (read-only snapshots for
    /// the embedded editor). Size-capped like the live editor endpoint.
    pub fn get_commit_file(
        &self,
        repo_path: &Path,
        oid_str: &str,
        rel_path: &str,
    ) -> Result<String, GitServiceError> {
        const MAX_BYTES: usize = 2 * 1024 * 1024;
        let repo = self.open_repo(repo_path)?;
        let oid = git2::Oid::from_str(oid_str)?;
        let commit = repo.find_commit(oid)?;
        let entry = commit.tree()?.get_path(Path::new(rel_path))?;
        let blob = entry
            .to_object(&repo)?
            .into_blob()
            .map_err(|_| GitServiceError::InvalidRepository("Not a file".to_string()))?;
        if blob.content().len() > MAX_BYTES {
            return Err(GitServiceError::InvalidRepository(
                "File too large for the editor".to_string(),
            ));
        }
        String::from_utf8(blob.content().to_vec()).map_err(|_| {
            GitServiceError::InvalidRepository("File is not valid UTF-8".to_string())
        })
    }

    /// Full detail of one commit: message, identity and per-file line stats
    /// against its first parent (or the empty tree for a root commit).
    pub fn get_commit_detail(
        &self,
        repo_path: &Path,
        oid_str: &str,
    ) -> Result<CommitDetail, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let oid = git2::Oid::from_str(oid_str)?;
        let commit = repo.find_commit(oid)?;

        let parent_tree = match commit.parent(0) {
            Ok(parent) => Some(parent.tree()?),
            Err(_) => None,
        };
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?;

        let mut files = Vec::new();
        let mut additions = 0usize;
        let mut deletions = 0usize;
        for (index, delta) in diff.deltas().enumerate() {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Renamed => "renamed",
                _ => "modified",
            }
            .to_string();
            let (file_add, file_del) =
                match git2::Patch::from_diff(&diff, index) {
                    Ok(Some(patch)) => {
                        let (_, add, del) = patch.line_stats()?;
                        (add, del)
                    }
                    _ => (0, 0),
                };
            additions += file_add;
            deletions += file_del;
            files.push(CommitFileChange {
                path,
                status,
                additions: file_add,
                deletions: file_del,
            });
        }

        Ok(CommitDetail {
            oid: oid.to_string(),
            short_oid: oid.to_string()[..7].to_string(),
            message: commit.message().unwrap_or_default().trim_end().to_string(),
            author: commit.author().name().unwrap_or_default().to_string(),
            author_email: commit.author().email().unwrap_or_default().to_string(),
            committed_at: DateTime::from_timestamp(commit.time().seconds(), 0)
                .unwrap_or_else(Utc::now),
            parent_oids: commit.parent_ids().map(|p| p.to_string()).collect(),
            files,
            additions,
            deletions,
        })
    }

    /// Position of a commit within the fleet-graph ordering (same tips +
    /// time-desc sort as `get_fleet_graph`), so the client can page straight
    /// to it. `None` = not reachable within the walk cap.
    pub fn locate_fleet_commit(
        &self,
        repo_path: &Path,
        base_branch: &str,
        tip_branches: &[String],
        oid_str: &str,
    ) -> Result<Option<usize>, GitServiceError> {
        const MAX_COMMITS_PER_BRANCH: usize = 50;
        const MAX_BASE_WALK: usize = 20_000;

        let repo = self.open_repo(repo_path)?;
        let target = git2::Oid::from_str(oid_str)?;
        let base_oid = Self::find_branch(&repo, base_branch)?
            .get()
            .peel_to_commit()?
            .id();

        // (oid, commit time) pairs — same population as the graph walk.
        let mut items: Vec<(git2::Oid, i64)> = Vec::new();
        let mut seen: HashSet<git2::Oid> = HashSet::new();
        let mut found = false;

        for branch_name in tip_branches {
            let Ok(branch) = Self::find_branch(&repo, branch_name) else {
                continue;
            };
            let Ok(tip_commit) = branch.get().peel_to_commit() else {
                continue;
            };
            let mut walk = repo.revwalk()?;
            walk.push(tip_commit.id())?;
            walk.hide(base_oid)?;
            walk.set_sorting(Sort::TIME)?;
            for oid in walk.take(MAX_COMMITS_PER_BRANCH) {
                let oid = oid?;
                if !seen.insert(oid) {
                    continue;
                }
                found |= oid == target;
                items.push((oid, repo.find_commit(oid)?.time().seconds()));
            }
        }

        // Base walk is time-ordered: once the target shows up, everything
        // newer is already collected, so the sorted position is final.
        let mut walk = repo.revwalk()?;
        walk.push(base_oid)?;
        walk.set_sorting(Sort::TIME)?;
        for oid in walk.take(MAX_BASE_WALK) {
            let oid = oid?;
            if !seen.insert(oid) {
                continue;
            }
            items.push((oid, repo.find_commit(oid)?.time().seconds()));
            if oid == target {
                found = true;
                break;
            }
        }

        if !found {
            return Ok(None);
        }
        items.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(items.iter().position(|(oid, _)| *oid == target))
    }

    /// Multi-branch commit graph for the fleet view (SHELL-SPEC V4): commits
    /// exclusive to each attempt branch (tip ^base) tagged with the branch
    /// name, plus recent base commits, merged newest-first. Unresolvable tips
    /// are skipped so callers can pass workspace branches blindly.
    pub fn get_fleet_graph(
        &self,
        repo_path: &Path,
        base_branch: &str,
        tip_branches: &[String],
        limit: usize,
        offset: usize,
    ) -> Result<FleetGraph, GitServiceError> {
        const MAX_COMMITS_PER_BRANCH: usize = 50;
        let window = offset.saturating_add(limit);

        let repo = self.open_repo(repo_path)?;
        let base_oid = Self::find_branch(&repo, base_branch)?
            .get()
            .peel_to_commit()?
            .id();

        let commit_info = |repo: &Repository,
                           oid: git2::Oid,
                           branch: Option<String>|
         -> Result<FleetGraphCommit, GitServiceError> {
            let commit = repo.find_commit(oid)?;
            let committed_at = DateTime::from_timestamp(commit.time().seconds(), 0)
                .unwrap_or_else(Utc::now);
            Ok(FleetGraphCommit {
                oid: oid.to_string(),
                short_oid: oid.to_string()[..7].to_string(),
                parent_oids: commit.parent_ids().map(|p| p.to_string()).collect(),
                summary: commit.summary().unwrap_or_default().to_string(),
                author: commit
                    .author()
                    .name()
                    .unwrap_or_default()
                    .to_string(),
                committed_at,
                branch,
                tip_of: Vec::new(),
            })
        };

        let mut commits: Vec<FleetGraphCommit> = Vec::new();
        let mut seen: HashSet<git2::Oid> = HashSet::new();
        let mut tips: Vec<FleetGraphTip> = Vec::new();
        let mut tip_names_by_oid: HashMap<String, Vec<String>> = HashMap::new();

        for branch_name in tip_branches {
            let Ok(branch) = Self::find_branch(&repo, branch_name) else {
                continue;
            };
            let Ok(tip_commit) = branch.get().peel_to_commit() else {
                continue;
            };
            let tip_oid = tip_commit.id();
            let (ahead, behind) = repo.graph_ahead_behind(tip_oid, base_oid).unwrap_or((0, 0));
            tips.push(FleetGraphTip {
                branch: branch_name.clone(),
                oid: tip_oid.to_string(),
                ahead_from_base: ahead,
                behind_from_base: behind,
            });
            tip_names_by_oid
                .entry(tip_oid.to_string())
                .or_default()
                .push(branch_name.clone());

            // Commits exclusive to this branch (not reachable from base).
            let mut walk = repo.revwalk()?;
            walk.push(tip_oid)?;
            walk.hide(base_oid)?;
            walk.set_sorting(Sort::TIME)?;
            for oid in walk.take(MAX_COMMITS_PER_BRANCH) {
                let oid = oid?;
                // A commit shared by two attempt branches keeps its first tag.
                if !seen.insert(oid) {
                    continue;
                }
                commits.push(commit_info(&repo, oid, Some(branch_name.clone()))?);
            }
        }

        // Recent base commits (includes merged attempt branches' history).
        // Walk one past the window so has_more is exact.
        let mut walk = repo.revwalk()?;
        walk.push(base_oid)?;
        walk.set_sorting(Sort::TIME)?;
        for oid in walk.take(window + 1) {
            let oid = oid?;
            if !seen.insert(oid) {
                continue;
            }
            commits.push(commit_info(&repo, oid, None)?);
        }

        commits.sort_by(|a, b| b.committed_at.cmp(&a.committed_at));
        let has_more = commits.len() > window;
        let end = window.min(commits.len());
        let start = offset.min(end);
        let mut commits: Vec<FleetGraphCommit> = commits.drain(start..end).collect();

        for commit in &mut commits {
            if let Some(names) = tip_names_by_oid.get(&commit.oid) {
                commit.tip_of = names.clone();
            }
        }

        Ok(FleetGraph {
            base_branch: base_branch.to_string(),
            commits,
            tips,
            has_more,
        })
    }

    /// Index-aware staging view (SHELL-SPEC V5): per-file staged/unstaged
    /// hunks from `git diff` / `git diff --cached`, plus untracked files.
    pub fn get_staging_state(
        &self,
        worktree_path: &Path,
    ) -> Result<StagingState, GitServiceError> {
        let cli = GitCli::new();
        let status = cli.get_worktree_status(worktree_path)?;
        let unstaged_raw = cli.git(worktree_path, ["diff", "--no-color", "--no-ext-diff"])?;
        let staged_raw = cli.git(
            worktree_path,
            ["diff", "--cached", "--no-color", "--no-ext-diff"],
        )?;

        let mut files: Vec<StagingFile> = Vec::new();
        let mut index_by_path: HashMap<String, usize> = HashMap::new();
        let entry_for = |files: &mut Vec<StagingFile>,
                             index_by_path: &mut HashMap<String, usize>,
                             path: String|
         -> usize {
            if let Some(&i) = index_by_path.get(&path) {
                return i;
            }
            files.push(StagingFile {
                path: path.clone(),
                status: "modified".to_string(),
                is_binary: false,
                staged_hunks: Vec::new(),
                unstaged_hunks: Vec::new(),
                has_staged_changes: false,
                has_unstaged_changes: false,
            });
            index_by_path.insert(path, files.len() - 1);
            files.len() - 1
        };

        for parsed in parse_unified_diff(&unstaged_raw) {
            let i = entry_for(&mut files, &mut index_by_path, parsed.path.clone());
            files[i].is_binary |= parsed.is_binary;
            files[i].unstaged_hunks = parsed.hunks;
        }
        for parsed in parse_unified_diff(&staged_raw) {
            let i = entry_for(&mut files, &mut index_by_path, parsed.path.clone());
            files[i].is_binary |= parsed.is_binary;
            files[i].staged_hunks = parsed.hunks;
        }

        for entry in &status.entries {
            let path = String::from_utf8_lossy(&entry.path).to_string();
            let i = entry_for(&mut files, &mut index_by_path, path);
            let file = &mut files[i];
            if entry.is_untracked {
                file.status = "untracked".to_string();
                file.has_unstaged_changes = true;
                continue;
            }
            file.has_staged_changes = entry.staged != ' ' && entry.staged != '?';
            file.has_unstaged_changes = entry.unstaged != ' ' && entry.unstaged != '?';
            file.status = match (entry.staged, entry.unstaged) {
                ('A', _) | (_, 'A') => "added",
                ('D', _) | (_, 'D') => "deleted",
                ('R', _) | (_, 'R') => "renamed",
                _ => "modified",
            }
            .to_string();
        }

        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(StagingState { files })
    }

    /// Stage a whole path (tracked or untracked).
    pub fn stage_path(
        &self,
        worktree_path: &Path,
        path: &str,
    ) -> Result<(), GitServiceError> {
        Ok(GitCli::new().add_path(worktree_path, path)?)
    }

    /// Unstage a whole path, keeping worktree content.
    pub fn unstage_path(
        &self,
        worktree_path: &Path,
        path: &str,
    ) -> Result<(), GitServiceError> {
        Ok(GitCli::new().restore_staged(worktree_path, path)?)
    }

    /// Stage (or with `reverse`, unstage) a single hunk patch in the index.
    pub fn apply_hunk_to_index(
        &self,
        worktree_path: &Path,
        patch: &str,
        reverse: bool,
    ) -> Result<(), GitServiceError> {
        Ok(GitCli::new().apply_cached(worktree_path, patch, reverse)?)
    }

    /// Commit only what is staged; returns the new head OID.
    pub fn commit_staged(
        &self,
        worktree_path: &Path,
        message: &str,
    ) -> Result<String, GitServiceError> {
        let cli = GitCli::new();
        self.ensure_cli_commit_identity(worktree_path)?;
        cli.commit(worktree_path, message)?;
        let repo = self.open_repo(worktree_path)?;
        Ok(repo.head()?.peel_to_commit()?.id().to_string())
    }
}

/// Compute addition/deletion counts between two text snapshots using libgit2.
pub fn compute_line_change_counts(old: &str, new: &str) -> (usize, usize) {
    fn ensure_newline(s: &str) -> std::borrow::Cow<'_, str> {
        if s.ends_with('\n') {
            std::borrow::Cow::Borrowed(s)
        } else {
            let mut owned = s.to_owned();
            owned.push('\n');
            std::borrow::Cow::Owned(owned)
        }
    }

    let old = ensure_newline(old);
    let new = ensure_newline(new);

    let mut opts = DiffOptions::new();
    opts.context_lines(0);

    match git2::Patch::from_buffers(old.as_bytes(), None, new.as_bytes(), None, Some(&mut opts))
        .and_then(|patch| patch.line_stats())
    {
        Ok((_, adds, dels)) => (adds, dels),
        Err(e) => {
            tracing::error!("git2 diff failed: {}", e);
            (0, 0)
        }
    }
}
