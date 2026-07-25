mod detection;
mod types;

pub mod azure;
pub mod github;

use std::path::Path;

use async_trait::async_trait;
use detection::detect_provider_from_url;
use enum_dispatch::enum_dispatch;
pub use types::{
    CreatePrRequest, GitHostError, LatestPrReview, PrComment, PrCommentAuthor, PrReviewComment,
    ProviderKind, PullRequestDetail, ReviewCommentUser, UnifiedPrComment,
};

use self::{azure::AzureDevOpsProvider, github::GitHubProvider};

#[async_trait]
#[enum_dispatch(GitHostService)]
pub trait GitHostProvider: Send + Sync {
    async fn create_pr(
        &self,
        repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GitHostError>;

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestDetail, GitHostError>;

    async fn list_prs_for_branch(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError>;

    async fn get_pr_comments(
        &self,
        repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError>;

    async fn list_open_prs(
        &self,
        repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError>;

    /// Return the mergeable state of a PR: "mergeable", "conflicting", or "unknown".
    async fn get_pr_mergeable(&self, pr_url: &str) -> Result<String, GitHostError>;

    /// Roll up the CI checks of a PR into one state: "passing", "failing",
    /// "pending", "none" (no checks), or "unknown" (host can't tell).
    async fn get_pr_ci_status(&self, pr_url: &str) -> Result<String, GitHostError>;

    /// Return the latest actionable review state for a PR, if any.
    /// Possible values: `"approved"`, `"changes_requested"`. Returns `None`
    /// when there are no submitted reviews with an actionable state (e.g. only
    /// comments or no reviews at all).
    async fn get_pr_latest_review_state(
        &self,
        pr_url: &str,
    ) -> Result<Option<String>, GitHostError>;

    /// Latest actionable review (`approved` / `changes_requested`) together
    /// with the commit it was made against and the PR's current head.
    /// Returns `None` when no actionable review exists, or on hosts that do
    /// not support review introspection.
    async fn get_pr_latest_review(
        &self,
        pr_url: &str,
    ) -> Result<Option<LatestPrReview>, GitHostError>;

    fn provider_kind(&self) -> ProviderKind;
}

#[enum_dispatch]
pub enum GitHostService {
    GitHub(GitHubProvider),
    AzureDevOps(AzureDevOpsProvider),
}

impl GitHostService {
    pub fn from_url(url: &str) -> Result<Self, GitHostError> {
        Self::from_url_with_token(url, None)
    }

    /// Like `from_url`, but plumbs an optional per-operation credential to
    /// the underlying provider. Currently only GitHub honours the token
    /// (via `GH_TOKEN`); Azure DevOps ignores it and falls back to the
    /// machine's `az` credentials — this keeps the trait signatures uniform
    /// without pretending to support something we don't.
    pub fn from_url_with_token(
        url: &str,
        token: Option<String>,
    ) -> Result<Self, GitHostError> {
        match detect_provider_from_url(url) {
            ProviderKind::GitHub => Ok(Self::GitHub(GitHubProvider::with_token(token)?)),
            ProviderKind::AzureDevOps => Ok(Self::AzureDevOps(AzureDevOpsProvider::new()?)),
            ProviderKind::Unknown => Err(GitHostError::UnsupportedProvider),
        }
    }
}
