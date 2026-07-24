//! Minimal helpers around the GitHub CLI (`gh`).
//!
//! This module provides low-level access to the GitHub CLI for operations
//! the REST client does not cover well.

use std::{
    ffi::{OsStr, OsString},
    io::Write,
    path::Path,
    process::Command,
};

use chrono::{DateTime, Utc};
use db::models::merge::MergeStatus;
use serde::Deserialize;
use tempfile::NamedTempFile;
use thiserror::Error;
use url::Url;
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path_blocking};

use crate::types::{
    CreatePrRequest, LatestPrReview, PrComment, PrCommentAuthor, PrReviewComment,
    PullRequestDetail, ReviewCommentUser,
};

#[derive(Debug, Clone)]
pub struct GitHubRepoInfo {
    pub owner: String,
    pub repo_name: String,
    /// GitHub hostname (e.g., "github.com" or enterprise hostname)
    pub hostname: Option<String>,
}

impl GitHubRepoInfo {
    pub fn repo_spec(&self) -> String {
        match &self.hostname {
            Some(host) => format!("{}/{}/{}", host, self.owner, self.repo_name),
            None => format!("{}/{}", self.owner, self.repo_name),
        }
    }
}

#[derive(Deserialize)]
struct GhRepoViewResponse {
    owner: GhRepoOwner,
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct GhRepoOwner {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCommentResponse {
    id: String,
    author: Option<GhUserLogin>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    body: String,
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
struct GhCommentsWrapper {
    comments: Vec<GhCommentResponse>,
}

#[derive(Deserialize)]
struct GhUserLogin {
    login: Option<String>,
}

#[derive(Deserialize)]
struct GhReviewCommentResponse {
    id: i64,
    user: Option<GhUserLogin>,
    #[serde(default)]
    body: String,
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    path: String,
    line: Option<i64>,
    side: Option<String>,
    #[serde(default)]
    diff_hunk: String,
    #[serde(default)]
    author_association: String,
}

#[derive(Deserialize)]
struct GhMergeCommit {
    oid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrResponse {
    number: i64,
    url: String,
    #[serde(default)]
    state: String,
    merged_at: Option<DateTime<Utc>>,
    merge_commit: Option<GhMergeCommit>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    base_ref_name: Option<String>,
    #[serde(default)]
    head_ref_name: Option<String>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Error)]
pub enum GhCliError {
    #[error("GitHub CLI (`gh`) executable not found or not runnable")]
    NotAvailable,
    #[error("GitHub CLI command failed: {0}")]
    CommandFailed(String),
    #[error("GitHub CLI authentication failed: {0}")]
    AuthFailed(String),
    #[error("GitHub CLI returned unexpected output: {0}")]
    UnexpectedOutput(String),
}

#[derive(Debug, Clone, Default)]
pub struct GhCli;

impl GhCli {
    pub fn new() -> Self {
        Self {}
    }

    /// Ensure the GitHub CLI binary is discoverable.
    fn ensure_available(&self) -> Result<(), GhCliError> {
        resolve_executable_path_blocking("gh").ok_or(GhCliError::NotAvailable)?;
        Ok(())
    }

    fn run<I, S>(&self, args: I, dir: Option<&Path>) -> Result<String, GhCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.ensure_available()?;
        let gh = resolve_executable_path_blocking("gh").ok_or(GhCliError::NotAvailable)?;
        let mut cmd = Command::new(&gh);
        if let Some(d) = dir {
            cmd.current_dir(d);
        }
        for arg in args {
            cmd.arg(arg);
        }
        let output = cmd
            .no_window()
            .output()
            .map_err(|err| GhCliError::CommandFailed(err.to_string()))?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        // Check exit code first - gh CLI uses exit code 4 for auth failures
        if output.status.code() == Some(4) {
            return Err(GhCliError::AuthFailed(stderr));
        }

        // Fall back to string matching for older gh versions or other auth scenarios
        let lower = stderr.to_ascii_lowercase();
        if lower.contains("authentication failed")
            || lower.contains("must authenticate")
            || lower.contains("bad credentials")
            || lower.contains("unauthorized")
            || lower.contains("gh auth login")
        {
            return Err(GhCliError::AuthFailed(stderr));
        }

        Err(GhCliError::CommandFailed(stderr))
    }

    pub fn get_repo_info(
        &self,
        remote_url: &str,
        repo_path: &Path,
    ) -> Result<GitHubRepoInfo, GhCliError> {
        let raw = self.run(
            ["repo", "view", remote_url, "--json", "owner,name,url"],
            Some(repo_path),
        )?;
        Self::parse_repo_info_response(&raw)
    }

    fn parse_repo_info_response(raw: &str) -> Result<GitHubRepoInfo, GhCliError> {
        let resp: GhRepoViewResponse = serde_json::from_str(raw).map_err(|e| {
            GhCliError::UnexpectedOutput(format!("Failed to parse gh repo view response: {e}"))
        })?;

        let hostname = Url::parse(&resp.url)
            .ok()
            .and_then(|u| u.host_str().map(String::from));

        Ok(GitHubRepoInfo {
            owner: resp.owner.login,
            repo_name: resp.name,
            hostname,
        })
    }

    /// Run `gh pr create` and parse the response.
    ///
    /// The `repo_path` parameter specifies the working directory for the command.
    /// This is required for compatibility with older `gh` CLI versions (e.g., v2.4.0)
    /// that require running from within a git repository.
    pub fn create_pr(
        &self,
        request: &CreatePrRequest,
        repo_info: &GitHubRepoInfo,
        repo_path: &Path,
    ) -> Result<PullRequestDetail, GhCliError> {
        // Write body to temp file to avoid shell escaping and length issues
        let body = request.body.as_deref().unwrap_or("");
        let mut body_file = NamedTempFile::new()
            .map_err(|e| GhCliError::CommandFailed(format!("Failed to create temp file: {e}")))?;
        body_file
            .write_all(body.as_bytes())
            .map_err(|e| GhCliError::CommandFailed(format!("Failed to write body: {e}")))?;

        let repo_spec = repo_info.repo_spec();

        let mut args: Vec<OsString> = Vec::with_capacity(14);
        args.push(OsString::from("pr"));
        args.push(OsString::from("create"));
        args.push(OsString::from("--repo"));
        args.push(OsString::from(&repo_spec));
        args.push(OsString::from("--head"));
        args.push(OsString::from(&request.head_branch));
        args.push(OsString::from("--base"));
        args.push(OsString::from(&request.base_branch));
        args.push(OsString::from("--title"));
        args.push(OsString::from(&request.title));
        args.push(OsString::from("--body-file"));
        args.push(body_file.path().as_os_str().to_os_string());

        if request.draft.unwrap_or(false) {
            args.push(OsString::from("--draft"));
        }

        let raw = self.run(args, Some(repo_path))?;
        Self::parse_pr_create_text(&raw, request)
    }

    /// Retrieve details for a pull request by URL.
    pub fn view_pr(&self, pr_url: &str) -> Result<PullRequestDetail, GhCliError> {
        let raw = self.run(
            [
                "pr",
                "view",
                pr_url,
                "--json",
                "number,url,state,mergedAt,mergeCommit,title,baseRefName,headRefName",
            ],
            None,
        )?;
        Self::parse_pr_view(&raw)
    }

    /// List pull requests for a branch (includes closed/merged).
    pub fn list_prs_for_branch(
        &self,
        repo_info: &GitHubRepoInfo,
        branch: &str,
    ) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let repo_spec = repo_info.repo_spec();
        let raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "all",
                "--head",
                branch,
                "--json",
                "number,url,title,headRefName,baseRefName,state,mergedAt,mergeCommit",
            ],
            None,
        )?;
        Self::parse_pr_list(&raw)
    }

    pub fn list_prs(&self, owner: &str, repo: &str) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let repo_spec = format!("{owner}/{repo}");
        let json_fields =
            "number,url,title,headRefName,baseRefName,state,mergedAt,mergeCommit,updatedAt";

        let open_raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "open",
                "--json",
                json_fields,
            ],
            None,
        )?;

        let closed_raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "closed",
                "--limit",
                "20",
                "--json",
                json_fields,
            ],
            None,
        )?;

        let mut open_prs: Vec<GhPrResponse> =
            serde_json::from_str(open_raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse gh pr list (open) response: {err}; raw: {open_raw}"
                ))
            })?;
        let closed_prs: Vec<GhPrResponse> =
            serde_json::from_str(closed_raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse gh pr list (closed) response: {err}; raw: {closed_raw}"
                ))
            })?;

        open_prs.extend(closed_prs);
        open_prs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        Ok(open_prs
            .into_iter()
            .map(Self::pr_response_to_detail)
            .collect())
    }

    /// Fetch comments for a pull request.
    pub fn get_pr_comments(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrComment>, GhCliError> {
        let repo_spec = repo_info.repo_spec();
        let raw = self.run(
            [
                "pr",
                "view",
                &pr_number.to_string(),
                "--repo",
                &repo_spec,
                "--json",
                "comments",
            ],
            None,
        )?;
        Self::parse_pr_comments(&raw)
    }

    /// Fetch inline review comments for a pull request via API.
    pub fn get_pr_review_comments(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrReviewComment>, GhCliError> {
        let mut args = vec![
            "api".to_string(),
            format!(
                "repos/{}/{}/pulls/{}/comments",
                repo_info.owner, repo_info.repo_name, pr_number
            ),
        ];
        if let Some(ref host) = repo_info.hostname {
            args.push("--hostname".to_string());
            args.push(host.clone());
        }
        let raw = self.run(args, None)?;
        Self::parse_pr_review_comments(&raw)
    }

    /// Return the mergeable state of a pull request: "mergeable", "conflicting", or "unknown".
    pub fn get_pr_mergeable(&self, pr_url: &str) -> Result<String, GhCliError> {
        let raw = self.run(["pr", "view", pr_url, "--json", "mergeable"], None)?;
        let value: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|e| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view --json mergeable: {e}; raw: {raw}"
            ))
        })?;
        let state = value
            .get("mergeable")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_ascii_lowercase();
        Ok(state)
    }

    /// Roll up the CI checks of a pull request into a single state:
    /// "passing", "failing", "pending", or "none" (no checks configured).
    pub fn get_pr_ci_status(&self, pr_url: &str) -> Result<String, GhCliError> {
        let raw = self.run(["pr", "view", pr_url, "--json", "statusCheckRollup"], None)?;
        let value: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|e| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view --json statusCheckRollup: {e}; raw: {raw}"
            ))
        })?;
        let checks = value
            .get("statusCheckRollup")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(Self::rollup_ci_checks(&checks))
    }

    /// Reduce `statusCheckRollup` entries (CheckRun or StatusContext objects)
    /// to one state. Any failure wins, then any pending, then passing.
    fn rollup_ci_checks(checks: &[serde_json::Value]) -> String {
        let mut any_pending = false;
        let mut any_passing = false;
        for check in checks {
            // CheckRun: status COMPLETED + conclusion; StatusContext: state.
            let state = check
                .get("conclusion")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| check.get("state").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_ascii_uppercase();
            let status = check
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_uppercase();
            if !status.is_empty() && status != "COMPLETED" {
                any_pending = true;
                continue;
            }
            match state.as_str() {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => any_passing = true,
                "PENDING" | "EXPECTED" | "" => any_pending = true,
                // FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, …
                _ => return "failing".to_string(),
            }
        }
        if any_pending {
            "pending".to_string()
        } else if any_passing {
            "passing".to_string()
        } else {
            "none".to_string()
        }
    }

    /// Return the latest actionable review state for a PR.
    /// Returns `None` when there are no submitted reviews with state
    /// `"approved"` or `"changes_requested"`.
    pub fn get_pr_latest_review_state(&self, pr_url: &str) -> Result<Option<String>, GhCliError> {
        let raw = self.run(["pr", "view", pr_url, "--json", "reviews"], None)?;

        #[derive(serde::Deserialize)]
        struct Review {
            state: String,
        }
        #[derive(serde::Deserialize)]
        struct Response {
            reviews: Vec<Review>,
        }

        let resp: Response = serde_json::from_str(raw.trim()).map_err(|e| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view --json reviews: {e}; raw: {raw}"
            ))
        })?;

        let state = resp
            .reviews
            .iter()
            .rev()
            .map(|r| r.state.to_ascii_lowercase())
            .find(|s| s == "approved" || s == "changes_requested");

        Ok(state)
    }

    /// Latest actionable review together with the commit it was made against
    /// and the PR's current head. Lets callers detect pushes made after the
    /// last review verdict.
    ///
    /// Uses the GitHub REST reviews endpoint instead of `gh pr view --json reviews`
    /// because the CLI's reviews fragment does not expose `commit.oid`. The REST
    /// endpoint always includes `commit_id` (the SHA the review was submitted
    /// against), which is the key piece for SHA-based re-review detection.
    pub fn get_pr_latest_review(
        &self,
        pr_url: &str,
    ) -> Result<Option<LatestPrReview>, GhCliError> {
        let (owner, repo, pr_number, hostname) =
            Self::parse_github_pr_url_parts(pr_url).ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "Cannot parse GitHub PR URL to fetch reviews: {pr_url}"
                ))
            })?;

        // REST endpoint always includes `commit_id` (the git SHA the review
        // was submitted against). Request up to 100 reviews — in practice
        // any PR has far fewer than that.
        let api_path =
            format!("repos/{owner}/{repo}/pulls/{pr_number}/reviews?per_page=100");
        let mut review_args: Vec<String> = vec!["api".to_string(), api_path];
        if let Some(ref host) = hostname {
            review_args.extend(["--hostname".to_string(), host.clone()]);
        }
        let reviews_raw = self.run(review_args, None)?;

        // Head SHA via gh pr view — `headRefOid` is non-nullable in GitHub's
        // schema, so this is reliable.
        let head_raw =
            self.run(["pr", "view", pr_url, "--json", "headRefOid"], None)?;

        #[derive(serde::Deserialize)]
        struct RestReview {
            state: String,
            commit_id: Option<String>,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct HeadInfo {
            head_ref_oid: Option<String>,
        }

        let reviews: Vec<RestReview> =
            serde_json::from_str(reviews_raw.trim()).map_err(|e| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse reviews REST response: {e}; raw: {reviews_raw}"
                ))
            })?;

        let head_info: HeadInfo =
            serde_json::from_str(head_raw.trim()).map_err(|e| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse headRefOid response: {e}; raw: {head_raw}"
                ))
            })?;

        let latest = reviews.iter().rev().find(|r| {
            let s = r.state.to_ascii_lowercase();
            s == "approved" || s == "changes_requested"
        });

        Ok(latest.map(|r| LatestPrReview {
            state: r.state.to_ascii_lowercase(),
            reviewed_sha: r.commit_id.clone(),
            head_sha: head_info.head_ref_oid,
        }))
    }

    /// Parse a GitHub PR URL into `(owner, repo, pr_number, hostname)`.
    ///
    /// `hostname` is `None` for `github.com` and `Some(host)` for GitHub
    /// Enterprise instances, matching what `gh api --hostname` expects.
    /// Returns `None` when the URL doesn't match the expected
    /// `https://{host}/{owner}/{repo}/pull/{number}` pattern.
    fn parse_github_pr_url_parts(
        pr_url: &str,
    ) -> Option<(String, String, i64, Option<String>)> {
        let url = Url::parse(pr_url).ok()?;
        let host = url.host_str()?.to_string();
        let mut segments = url.path_segments()?;
        let owner = segments.next()?.to_string();
        let repo = segments.next()?.to_string();
        let path_type = segments.next()?;
        let number_str = segments.next()?;
        if path_type != "pull" {
            return None;
        }
        let pr_number = number_str.parse::<i64>().ok()?;
        let hostname = if host == "github.com" {
            None
        } else {
            Some(host)
        };
        Some((owner, repo, pr_number, hostname))
    }

    pub fn pr_checkout(
        &self,
        repo_path: &Path,
        owner: &str,
        repo: &str,
        pr_number: i64,
    ) -> Result<(), GhCliError> {
        self.run(
            [
                "pr",
                "checkout",
                &pr_number.to_string(),
                "--repo",
                &format!("{owner}/{repo}"),
                "--force",
            ],
            Some(repo_path),
        )?;
        Ok(())
    }
}

impl GhCli {
    fn parse_pr_create_text(
        raw: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GhCliError> {
        let pr_url = raw
            .lines()
            .rev()
            .flat_map(|line| line.split_whitespace())
            .map(|token| token.trim_matches(|c: char| c == '<' || c == '>'))
            .find(|token| token.starts_with("http") && token.contains("/pull/"))
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "gh pr create did not return a pull request URL; raw output: {raw}"
                ))
            })?
            .trim_end_matches(['.', ',', ';'])
            .to_string();

        let number = pr_url
            .rsplit('/')
            .next()
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to extract PR number from URL '{pr_url}'"
                ))
            })?
            .trim_end_matches(|c: char| !c.is_ascii_digit())
            .parse::<i64>()
            .map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse PR number from URL '{pr_url}': {err}"
                ))
            })?;

        Ok(PullRequestDetail {
            number,
            url: pr_url,
            status: MergeStatus::Open,
            merged_at: None,
            merge_commit_sha: None,
            title: request.title.clone(),
            base_branch: request.base_branch.clone(),
            head_branch: request.head_branch.clone(),
        })
    }

    fn parse_pr_view(raw: &str) -> Result<PullRequestDetail, GhCliError> {
        let pr: GhPrResponse = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view response: {err}; raw: {raw}"
            ))
        })?;
        Ok(Self::pr_response_to_detail(pr))
    }

    fn parse_pr_list(raw: &str) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let prs: Vec<GhPrResponse> = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr list response: {err}; raw: {raw}"
            ))
        })?;
        Ok(prs.into_iter().map(Self::pr_response_to_detail).collect())
    }

    fn pr_response_to_detail(pr: GhPrResponse) -> PullRequestDetail {
        let state = if pr.state.is_empty() {
            "OPEN"
        } else {
            &pr.state
        };
        PullRequestDetail {
            number: pr.number,
            url: pr.url,
            status: match state.to_ascii_uppercase().as_str() {
                "OPEN" => MergeStatus::Open,
                "MERGED" => MergeStatus::Merged,
                "CLOSED" => MergeStatus::Closed,
                _ => MergeStatus::Unknown,
            },
            merged_at: pr.merged_at,
            merge_commit_sha: pr.merge_commit.and_then(|c| c.oid),
            title: pr.title.unwrap_or_default(),
            base_branch: pr.base_ref_name.unwrap_or_default(),
            head_branch: pr.head_ref_name.unwrap_or_default(),
        }
    }

    fn parse_pr_comments(raw: &str) -> Result<Vec<PrComment>, GhCliError> {
        let wrapper: GhCommentsWrapper = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view --json comments response: {err}; raw: {raw}"
            ))
        })?;

        Ok(wrapper
            .comments
            .into_iter()
            .map(|c| PrComment {
                id: c.id,
                author: PrCommentAuthor {
                    login: c
                        .author
                        .and_then(|a| a.login)
                        .unwrap_or_else(|| "unknown".to_string()),
                },
                author_association: c.author_association,
                body: c.body,
                created_at: c.created_at.unwrap_or_else(Utc::now),
                url: c.url,
            })
            .collect())
    }

    fn parse_pr_review_comments(raw: &str) -> Result<Vec<PrReviewComment>, GhCliError> {
        let items: Vec<GhReviewCommentResponse> =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse review comments API response: {err}; raw: {raw}"
                ))
            })?;

        Ok(items
            .into_iter()
            .map(|c| PrReviewComment {
                id: c.id,
                user: ReviewCommentUser {
                    login: c
                        .user
                        .and_then(|u| u.login)
                        .unwrap_or_else(|| "unknown".to_string()),
                },
                body: c.body,
                created_at: c.created_at.unwrap_or_else(Utc::now),
                html_url: c.html_url,
                path: c.path,
                line: c.line,
                side: c.side,
                diff_hunk: c.diff_hunk,
                author_association: c.author_association,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_pr_url_parts_github_com() {
        let result =
            GhCli::parse_github_pr_url_parts("https://github.com/myorg/myrepo/pull/42");
        let (owner, repo, number, hostname) = result.expect("should parse");
        assert_eq!(owner, "myorg");
        assert_eq!(repo, "myrepo");
        assert_eq!(number, 42);
        assert_eq!(hostname, None, "github.com needs no --hostname");
    }

    #[test]
    fn parse_github_pr_url_parts_enterprise() {
        let result = GhCli::parse_github_pr_url_parts(
            "https://github.mycompany.com/org/project/pull/7",
        );
        let (owner, repo, number, hostname) = result.expect("should parse");
        assert_eq!(owner, "org");
        assert_eq!(repo, "project");
        assert_eq!(number, 7);
        assert_eq!(hostname, Some("github.mycompany.com".to_string()));
    }

    #[test]
    fn parse_github_pr_url_parts_rejects_non_pr_urls() {
        // Issue URL — not a pull request
        assert!(GhCli::parse_github_pr_url_parts(
            "https://github.com/owner/repo/issues/42"
        )
        .is_none());

        // Malformed / not a URL
        assert!(GhCli::parse_github_pr_url_parts("not-a-url").is_none());

        // Missing number segment
        assert!(
            GhCli::parse_github_pr_url_parts("https://github.com/owner/repo/pull/").is_none()
        );

        // Non-integer number
        assert!(GhCli::parse_github_pr_url_parts(
            "https://github.com/owner/repo/pull/abc"
        )
        .is_none());
    }
}
