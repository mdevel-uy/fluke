use chrono::{DateTime, Utc};
use db::models::merge::{MergeStatus, PullRequestInfo};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    GitHub,
    AzureDevOps,
    Unknown,
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderKind::GitHub => write!(f, "GitHub"),
            ProviderKind::AzureDevOps => write!(f, "Azure DevOps"),
            ProviderKind::Unknown => write!(f, "Unknown"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CreatePrRequest {
    pub title: String,
    pub body: Option<String>,
    pub head_branch: String,
    pub base_branch: String,
    pub draft: Option<bool>,
    /// URL of the repo containing the head branch (for cross-fork PRs).
    pub head_repo_url: Option<String>,
}

#[derive(Debug, Error)]
pub enum GitHostError {
    #[error("Repository error: {0}")]
    Repository(String),
    #[error("Pull request error: {0}")]
    PullRequest(String),
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[error("Insufficient permissions: {0}")]
    InsufficientPermissions(String),
    #[error("Repository not found or no access: {0}")]
    RepoNotFoundOrNoAccess(String),
    #[error("{provider} CLI is not installed or not available in PATH")]
    CliNotInstalled { provider: ProviderKind },
    #[error("Not a git repository: {0}")]
    NotAGitRepository(String),
    #[error("Unsupported git hosting provider")]
    UnsupportedProvider,
    #[error("CLI returned unexpected output: {0}")]
    UnexpectedOutput(String),
}

impl GitHostError {
    pub fn should_retry(&self) -> bool {
        !matches!(
            self,
            GitHostError::AuthFailed(_)
                | GitHostError::InsufficientPermissions(_)
                | GitHostError::RepoNotFoundOrNoAccess(_)
                | GitHostError::CliNotInstalled { .. }
                | GitHostError::NotAGitRepository(_)
                | GitHostError::UnsupportedProvider
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PrCommentAuthor {
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: String,
    pub author: PrCommentAuthor,
    pub author_association: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ReviewCommentUser {
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PrReviewComment {
    pub id: i64,
    pub user: ReviewCommentUser,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub html_url: String,
    pub path: String,
    pub line: Option<i64>,
    pub side: Option<String>,
    pub diff_hunk: String,
    pub author_association: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "comment_type", rename_all = "snake_case")]
#[ts(tag = "comment_type", rename_all = "snake_case")]
pub enum UnifiedPrComment {
    General {
        id: String,
        author: String,
        author_association: Option<String>,
        body: String,
        created_at: DateTime<Utc>,
        url: Option<String>,
    },
    Review {
        id: i64,
        author: String,
        author_association: Option<String>,
        body: String,
        created_at: DateTime<Utc>,
        url: Option<String>,
        path: String,
        line: Option<i64>,
        side: Option<String>,
        diff_hunk: Option<String>,
    },
}

impl UnifiedPrComment {
    pub fn created_at(&self) -> DateTime<Utc> {
        match self {
            UnifiedPrComment::General { created_at, .. } => *created_at,
            UnifiedPrComment::Review { created_at, .. } => *created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PullRequestDetail {
    pub number: i64,
    pub url: String,
    pub status: MergeStatus,
    pub merged_at: Option<DateTime<Utc>>,
    pub merge_commit_sha: Option<String>,
    pub title: String,
    pub base_branch: String,
    pub head_branch: String,
}

/// The latest actionable review on a PR plus the PR's current head commit.
/// Backend-internal (not TS-exported): used to decide whether a re-review is
/// warranted (new commits since the review) or the verdict still stands.
#[derive(Debug, Clone)]
pub struct LatestPrReview {
    /// `"approved"` or `"changes_requested"` (lowercase).
    pub state: String,
    /// Commit the review was submitted against, when the host reports it.
    pub reviewed_sha: Option<String>,
    /// Current head commit of the PR, when the host reports it.
    pub head_sha: Option<String>,
}

/// Server-side review submission: the reviewer's verdict, submitted to the
/// host by the orchestrator (using the reviewer worker's PAT) instead of
/// asking the agent to run `gh pr review` from its prompt.
///
/// `commit_id` is the SHA pinned at dispatch time. Submitting the review
/// against a specific commit is what makes the verdict *cover* that commit
/// even if the head moved by the time the reviewer finished writing.
#[derive(Debug, Clone)]
pub struct SubmitPrReviewRequest {
    pub pr_url: String,
    pub commit_id: String,
    /// `"APPROVE"` or `"REQUEST_CHANGES"` — the GitHub `event` string.
    pub event: String,
    pub body: String,
    pub comments: Vec<PrReviewCommentInput>,
}

/// One inline comment on the submitted review. Comments without `path`/`line`
/// go to the review body instead (the reviewer verdict schema allows both).
#[derive(Debug, Clone)]
pub struct PrReviewCommentInput {
    pub path: String,
    pub line: i64,
    pub body: String,
}

/// Return value of a successful server-side review submission: the review id
/// GitHub assigned, used as the external idempotency key on the round row.
#[derive(Debug, Clone)]
pub struct SubmitPrReviewResponse {
    pub review_id: i64,
}

/// A single CI check whose current state is not passing. Backend-internal:
/// used to enrich the "Fix CI" prompt with the exact failing job list up front
/// so the agent does not have to shell out to `gh pr checks` from its prompt.
#[derive(Debug, Clone)]
pub struct PrFailedCheck {
    /// Job / context name (e.g. "backend", "lint / eslint").
    pub name: String,
    /// Conclusion or state, lowercase (e.g. `"failure"`, `"cancelled"`,
    /// `"timed_out"`, `"action_required"`, `"error"`). For pending checks the
    /// value is `"pending"` — those never make it into this list because we
    /// filter to failing states only.
    pub conclusion: String,
    /// URL to the run / details page for the check, when the host reports it.
    pub details_url: Option<String>,
}

impl From<PullRequestDetail> for PullRequestInfo {
    fn from(d: PullRequestDetail) -> Self {
        PullRequestInfo {
            number: d.number,
            url: d.url,
            status: d.status,
            merged_at: d.merged_at,
            merge_commit_sha: d.merge_commit_sha,
            mergeable: None,
        }
    }
}
