//! CI Pipeline Studio: commit compiled workflow files to a fresh branch and
//! open a PR. The branch is built in memory (git2) from the base branch tip,
//! so the repo's working tree and checked-out branch are never touched — the
//! frontend compiles the YAML, this route only does git + PR.

use axum::{Json, Router, extract::State, response::Json as ResponseJson, routing::post};
use db::models::repo::{Repo, RepoError};
use deployment::Deployment;
use git_host::{CreatePrRequest, GitHostProvider, GitHostService};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const WORKFLOWS_PREFIX: &str = ".github/workflows/";
const MAX_FILES: usize = 10;

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CiPipelineFile {
    /// Repo-relative path; must live under `.github/workflows/`.
    pub rel_path: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CreateCiPipelinePrRequest {
    pub repo_id: Uuid,
    pub files: Vec<CiPipelineFile>,
    pub branch_name: String,
    /// Defaults to the repo's default target branch.
    pub base_branch: Option<String>,
    pub commit_message: String,
    pub pr_title: String,
    pub pr_body: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CreateCiPipelinePrResponse {
    pub pr_url: String,
    pub branch: String,
    pub commit: String,
}

/// Only plain file names under `.github/workflows/` — no traversal, no
/// nested directories, no hidden files.
fn validate_rel_path(rel_path: &str) -> Result<(), ApiError> {
    let Some(name) = rel_path.strip_prefix(WORKFLOWS_PREFIX) else {
        return Err(ApiError::BadRequest(format!(
            "Path must be under {WORKFLOWS_PREFIX}: {rel_path}"
        )));
    };
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !name.contains("..");
    if !valid {
        return Err(ApiError::BadRequest(format!(
            "Invalid workflow file name: {rel_path}"
        )));
    }
    Ok(())
}

fn validate_branch_name(branch: &str) -> Result<(), ApiError> {
    let valid = !branch.is_empty()
        && !branch.starts_with('/')
        && !branch.ends_with('/')
        && !branch.contains("..")
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'));
    if !valid {
        return Err(ApiError::BadRequest(format!(
            "Invalid branch name: {branch}"
        )));
    }
    Ok(())
}

pub async fn compile_pr(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CreateCiPipelinePrRequest>,
) -> Result<ResponseJson<ApiResponse<CreateCiPipelinePrResponse>>, ApiError> {
    if request.files.is_empty() || request.files.len() > MAX_FILES {
        return Err(ApiError::BadRequest(format!(
            "Expected between 1 and {MAX_FILES} files"
        )));
    }
    for file in &request.files {
        validate_rel_path(&file.rel_path)?;
    }
    let branch = request.branch_name.trim().to_string();
    validate_branch_name(&branch)?;
    if request.pr_title.trim().is_empty() {
        return Err(ApiError::BadRequest("PR title is required".to_string()));
    }

    let pool = &deployment.db().pool;
    let repo = Repo::find_by_id(pool, request.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let base_branch = request
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| repo.default_target_branch.clone())
        .ok_or_else(|| {
            ApiError::BadRequest(
                "No base branch given and the repo has no default target branch".to_string(),
            )
        })?;

    let git = deployment.git();
    let files: Vec<(String, String)> = request
        .files
        .iter()
        .map(|f| (f.rel_path.clone(), f.content.clone()))
        .collect();

    let commit = match git.commit_files_to_new_branch(
        &repo.path,
        &base_branch,
        &branch,
        &files,
        request.commit_message.trim(),
    ) {
        Ok(oid) => oid,
        Err(e) if e.is_ref_exists() => {
            return Err(ApiError::Conflict(format!(
                "Branch '{branch}' already exists — pick another name"
            )));
        }
        Err(e) => return Err(ApiError::GitService(e)),
    };

    // Same identity story as the rest of the app: the stored OAuth token when
    // present, otherwise whatever gh/git credentials the machine has.
    let token = deployment.config().read().await.github.oauth_token.clone();

    git.push_branch_with_token(&repo.path, &branch, false, token.as_deref())?;

    let remote = git.get_default_remote(&repo.path)?;
    let git_host = GitHostService::from_url_with_token(&remote.url, token)?;
    let pr_request = CreatePrRequest {
        title: request.pr_title.trim().to_string(),
        body: request.pr_body.clone(),
        head_branch: branch.clone(),
        base_branch: base_branch.clone(),
        draft: None,
        head_repo_url: Some(remote.url.clone()),
    };
    let pr_info = git_host
        .create_pr(&repo.path, &remote.url, &pr_request)
        .await?;

    deployment
        .track_if_analytics_allowed(
            "ci_studio_pr_created",
            serde_json::json!({
                "repo_id": repo.id.to_string(),
                "files": request.files.len(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        CreateCiPipelinePrResponse {
            pr_url: pr_info.url,
            branch,
            commit,
        },
    )))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/ci-studio/compile-pr", post(compile_pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_workflow_paths() {
        assert!(validate_rel_path(".github/workflows/ci.yml").is_ok());
        assert!(validate_rel_path(".github/workflows/deploy.fluke.json").is_ok());
    }

    #[test]
    fn rejects_traversal_and_foreign_paths() {
        assert!(validate_rel_path(".github/workflows/../evil.yml").is_err());
        assert!(validate_rel_path(".github/workflows/a/b.yml").is_err());
        assert!(validate_rel_path("src/main.rs").is_err());
        assert!(validate_rel_path(".github/workflows/.hidden").is_err());
        assert!(validate_rel_path(".github/workflows/").is_err());
    }

    #[test]
    fn validates_branch_names() {
        assert!(validate_branch_name("vk/ci/deploy").is_ok());
        assert!(validate_branch_name("feature-1.2").is_ok());
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("bad name").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("/leading").is_err());
    }
}
