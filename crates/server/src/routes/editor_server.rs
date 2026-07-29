use std::path::{Path, PathBuf};

use axum::{
    Json, Router,
    extract::Query,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// Files larger than this are refused — the embedded editor is for source
/// files, not blobs.
const MAX_EDITABLE_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Content search limits.
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCHABLE_FILE_BYTES: u64 = 512 * 1024;
const SEARCH_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "vendor",
    "__pycache__",
];

#[derive(Debug, Deserialize)]
pub struct FileQuery {
    path: String,
}

/// Mirrored inline in the frontend client (like `getEditorPath`), so these
/// are not part of generate_types.
#[derive(Debug, Serialize)]
pub struct EditorFileContent {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveFileRequest {
    path: String,
    content: String,
}

fn validate_path(path: &str) -> Result<&Path, ApiError> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(ApiError::BadRequest(
            "File path must be absolute".to_string(),
        ));
    }
    Ok(p)
}

/// Read a text file for the embedded editor.
pub async fn read_file(
    Query(query): Query<FileQuery>,
) -> Result<ResponseJson<ApiResponse<EditorFileContent>>, ApiError> {
    let path = validate_path(&query.path)?;

    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Not a file".to_string()));
    }
    if metadata.len() > MAX_EDITABLE_FILE_BYTES {
        return Err(ApiError::BadRequest(format!(
            "File is too large to edit here ({} KB, limit {} KB)",
            metadata.len() / 1024,
            MAX_EDITABLE_FILE_BYTES / 1024
        )));
    }

    let bytes = tokio::fs::read(path).await?;
    let content = String::from_utf8(bytes).map_err(|_| {
        ApiError::BadRequest("File is binary or not valid UTF-8".to_string())
    })?;

    Ok(ResponseJson(ApiResponse::success(EditorFileContent {
        content,
    })))
}

/// Save a text file edited in the embedded editor.
pub async fn save_file(
    Json(payload): Json<SaveFileRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let path = validate_path(&payload.path)?;

    // Only overwrite existing files — the editor has no "create file" flow
    // yet, and this guards against typos writing stray files.
    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Not a file".to_string()));
    }

    tokio::fs::write(path, payload.content.as_bytes()).await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Deserialize)]
pub struct CreateEntryRequest {
    path: String,
    is_directory: bool,
}

#[derive(Debug, Deserialize)]
pub struct RenameEntryRequest {
    path: String,
    new_path: String,
}

#[derive(Debug, Deserialize)]
pub struct DeleteEntryRequest {
    path: String,
}

/// Create an empty file or a directory.
pub async fn create_entry(
    Json(payload): Json<CreateEntryRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let path = validate_path(&payload.path)?;

    if tokio::fs::try_exists(path).await? {
        return Err(ApiError::Conflict("Already exists".to_string()));
    }

    if payload.is_directory {
        tokio::fs::create_dir_all(path).await?;
    } else {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, b"").await?;
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Rename/move a file or directory.
pub async fn rename_entry(
    Json(payload): Json<RenameEntryRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let path = validate_path(&payload.path)?;
    let new_path = validate_path(&payload.new_path)?;

    if tokio::fs::try_exists(new_path).await? {
        return Err(ApiError::Conflict("Target already exists".to_string()));
    }

    tokio::fs::rename(path, new_path).await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Delete a file or directory (recursively).
pub async fn delete_entry(
    Json(payload): Json<DeleteEntryRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let path = validate_path(&payload.path)?;

    let metadata = tokio::fs::metadata(path).await?;
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(path).await?;
    } else {
        tokio::fs::remove_file(path).await?;
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Deserialize)]
pub struct ContentSearchQuery {
    root: String,
    q: String,
}

/// Mirrored inline in the frontend client.
#[derive(Debug, Serialize)]
pub struct ContentSearchHit {
    pub path: String,
    pub line: u32,
    pub preview: String,
}

/// Case-insensitive substring search over text files under `root`.
pub async fn search_content(
    Query(query): Query<ContentSearchQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<ContentSearchHit>>>, ApiError> {
    let root = validate_path(&query.root)?.to_path_buf();
    let needle = query.q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(ResponseJson(ApiResponse::success(Vec::new())));
    }

    let hits = tokio::task::spawn_blocking(move || search_content_blocking(&root, &needle))
        .await
        .map_err(|e| ApiError::BadRequest(format!("Search failed: {e}")))?;

    Ok(ResponseJson(ApiResponse::success(hits)))
}

fn search_content_blocking(root: &Path, needle: &str) -> Vec<ContentSearchHit> {
    let mut hits = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if hits.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if hits.len() >= MAX_SEARCH_RESULTS {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();

            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if !SEARCH_SKIP_DIRS.contains(&name.as_ref()) {
                    stack.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if entry
                .metadata()
                .map(|m| m.len() > MAX_SEARCHABLE_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };

            for (index, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(needle) {
                    hits.push(ContentSearchHit {
                        path: path.to_string_lossy().into_owned(),
                        line: (index + 1) as u32,
                        preview: line.trim().chars().take(200).collect(),
                    });
                    if hits.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
            }
        }
    }

    hits
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/editor/file", get(read_file).post(save_file))
        .route("/editor/create", post(create_entry))
        .route("/editor/rename", post(rename_entry))
        .route("/editor/delete", post(delete_entry))
        .route("/editor/search", get(search_content))
}
