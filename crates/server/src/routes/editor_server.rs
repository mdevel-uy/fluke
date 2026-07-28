use std::path::Path;

use axum::{
    Json, Router, extract::Query, response::Json as ResponseJson, routing::get,
};
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// Files larger than this are refused — the embedded editor is for source
/// files, not blobs.
const MAX_EDITABLE_FILE_BYTES: u64 = 2 * 1024 * 1024;

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

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/editor/file", get(read_file).post(save_file))
}
