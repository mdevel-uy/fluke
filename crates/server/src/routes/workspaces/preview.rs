use std::path::{Component, Path, PathBuf};

use axum::{
    Extension, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    middleware::from_fn_with_state,
    response::Response,
    routing::get,
};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use mime_guess::MimeGuess;
use services::services::{container::ContainerService, file::FileError};
use tokio::fs::File as TokioFile;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::attachments::load_workspace_with_wildcard;
use crate::{DeploymentImpl, error::ApiError};

/// Keep the browser sandboxed while still letting self-contained mockups run
/// their inline scripts: without `allow-same-origin` the document gets an
/// opaque origin, so it cannot call the API or read app storage.
const PREVIEW_CSP: &str = "sandbox allow-scripts allow-forms allow-popups allow-modals";

fn not_found() -> ApiError {
    ApiError::File(FileError::NotFound)
}

/// Reject anything that is not a plain relative path: no `..`, no absolute
/// paths, no drive prefixes, no `.git` internals.
fn is_safe_relative_path(path: &str) -> bool {
    let p = Path::new(path);
    p.components().all(|c| match c {
        Component::Normal(part) => part.to_str().is_some_and(|s| !s.eq_ignore_ascii_case(".git")),
        _ => false,
    })
}

/// Serve a file from the workspace worktree, rendered (correct content type)
/// instead of as JSON source. This is how HTML deliverables — e.g. a designer
/// worker's mockup under `design/` — become openable in a browser tab.
///
/// The wildcard is repo-relative (matching the paths shown in the Changes
/// view); for multi-repo workspaces each repo root is tried in order, and the
/// workspace root last.
pub async fn serve_preview_file(
    axum::extract::Path((_id, path)): axum::extract::Path<(Uuid, String)>,
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<Response, ApiError> {
    if !is_safe_relative_path(&path) {
        return Err(not_found());
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    deployment.container().touch(&workspace).await?;
    let workspace_root = PathBuf::from(container_ref);

    let canonical_root = tokio::fs::canonicalize(&workspace_root)
        .await
        .map_err(|_| not_found())?;

    let repos =
        WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, workspace.id).await?;
    let mut candidates: Vec<PathBuf> = repos
        .iter()
        .map(|repo| workspace_root.join(&repo.name).join(&path))
        .collect();
    candidates.push(workspace_root.join(&path));

    for candidate in candidates {
        let Ok(canonical) = tokio::fs::canonicalize(&candidate).await else {
            continue;
        };
        // canonicalize resolves symlinks, so a link pointing outside the
        // worktree fails this containment check even though the raw path
        // looked safe.
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        let Ok(metadata) = tokio::fs::metadata(&canonical).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        return stream_file(&canonical, &path, metadata.len()).await;
    }

    Err(not_found())
}

async fn stream_file(full_path: &Path, request_path: &str, len: u64) -> Result<Response, ApiError> {
    let file = TokioFile::open(full_path).await.map_err(|_| not_found())?;
    let body = Body::from_stream(ReaderStream::new(file));

    let raw_type = MimeGuess::from_path(request_path)
        .first_raw()
        .unwrap_or("application/octet-stream");
    let content_type = if raw_type.starts_with("text/") {
        format!("{raw_type}; charset=utf-8")
    } else {
        raw_type.to_string()
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, len)
        // Worktree contents change on every agent turn — never cache.
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, PREVIEW_CSP)
        .body(body)
        .map_err(|e| ApiError::File(FileError::ResponseBuildError(e.to_string())))
}

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        .route("/{*path}", get(serve_preview_file))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_workspace_with_wildcard,
        ))
}

#[cfg(test)]
mod tests {
    use super::is_safe_relative_path;

    #[test]
    fn accepts_plain_relative_paths() {
        assert!(is_safe_relative_path("design/worker-dialog-redesign.html"));
        assert!(is_safe_relative_path("design/assets/logo.svg"));
        assert!(is_safe_relative_path("README.md"));
    }

    #[test]
    fn rejects_traversal_absolute_and_git_paths() {
        assert!(!is_safe_relative_path("../secrets.txt"));
        assert!(!is_safe_relative_path("design/../../etc/passwd"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path("C:\\Windows\\win.ini"));
        assert!(!is_safe_relative_path(".git/config"));
        assert!(!is_safe_relative_path("repo/.git/HEAD"));
    }
}
