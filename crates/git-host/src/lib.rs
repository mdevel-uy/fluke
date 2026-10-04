mod detection;
mod types;

pub mod azure;
pub mod github;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use async_trait::async_trait;
use detection::detect_provider_from_url;
use enum_dispatch::enum_dispatch;
pub use types::{
    CreatePrRequest, GitHostError, LatestPrReview, PrComment, PrCommentAuthor, PrFailedCheck,
    PrMergeMethod, PrReviewComment, PrReviewCommentInput, ProviderKind, PullRequestDetail,
    ReviewCommentUser, SubmitPrReviewRequest, SubmitPrReviewResponse, UnifiedPrComment,
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

    /// List CI checks currently in a failing state (failure, error, cancelled,
    /// timed_out, action_required). Used to enrich the "Fix CI" prompt inline
    /// so the agent doesn't have to reach for `gh pr checks` from its prompt.
    /// Returns an empty vec when the host reports no failing checks or does
    /// not implement check introspection (Azure DevOps).
    async fn get_pr_failed_checks(&self, pr_url: &str) -> Result<Vec<PrFailedCheck>, GitHostError>;

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

    /// Mark the PR's requested changes as addressed once the author pushed a
    /// fix: dismiss the changes-requested reviews with `message` and resolve
    /// the open review threads. Returns `(reviews_dismissed, threads_resolved)`;
    /// hosts without the concept do nothing.
    async fn mark_changes_addressed(
        &self,
        _pr_url: &str,
        _message: &str,
        _submitted_before: chrono::DateTime<chrono::Utc>,
    ) -> Result<(usize, usize), GitHostError> {
        Ok((0, 0))
    }

    /// Current head SHA of a PR. Pinned at review dispatch so the eventual
    /// review submission ties its verdict to a specific commit even when the
    /// author pushes further work while the reviewer is running.
    async fn get_pr_head_sha(&self, pr_url: &str) -> Result<Option<String>, GitHostError>;

    /// New-side line coverage of the PR diff, per file, straight from the
    /// host. GitHub validates every inline review comment against this exact
    /// diff and rejects the whole submission with HTTP 422 when a single
    /// comment falls outside it, so callers use this to sanitize inline
    /// placement *before* submitting.
    ///
    /// `Ok(None)`: the provider can't supply the map (treat as "don't
    /// validate"). A file mapped to `None` is in the diff but its line
    /// coverage is unknown (the host omits the patch for very large files);
    /// keep inline comments on those.
    async fn get_pr_diff_line_map(
        &self,
        pr_url: &str,
    ) -> Result<Option<HashMap<String, Option<HashSet<i64>>>>, GitHostError>;

    /// Submit a PR review server-side using the calling provider's
    /// credentials (for GitHub, the PAT the provider was constructed with).
    /// The full verdict travels in one atomic API call — body, event
    /// (`APPROVE` / `REQUEST_CHANGES`), and inline comments — pinned to the
    /// commit_id captured at dispatch. Returns the review id assigned by the
    /// host.
    async fn submit_pr_review(
        &self,
        request: &SubmitPrReviewRequest,
    ) -> Result<SubmitPrReviewResponse, GitHostError>;

    /// Post a plain (non-review) comment on the PR conversation timeline.
    /// Used by the orchestrator for advisory checks that are not verdicts —
    /// e.g. the territory lint (issue #95). Best-effort at the caller: an
    /// error here must never abort the workflow that requested the comment,
    /// because none of the checks that use it are gates.
    async fn post_pr_comment(&self, pr_url: &str, body: &str) -> Result<(), GitHostError>;

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
    pub fn from_url_with_token(url: &str, token: Option<String>) -> Result<Self, GitHostError> {
        match detect_provider_from_url(url) {
            ProviderKind::GitHub => Ok(Self::GitHub(GitHubProvider::with_token(token)?)),
            ProviderKind::AzureDevOps => Ok(Self::AzureDevOps(AzureDevOpsProvider::new()?)),
            ProviderKind::Unknown => Err(GitHostError::UnsupportedProvider),
        }
    }
}
