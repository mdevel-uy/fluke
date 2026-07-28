use axum::{Router, extract::State, response::Json as ResponseJson, routing::post};
use serde::Serialize;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// Connection info for the embedded openvscode-server instance. The frontend
/// builds the iframe URL from this port via the preview proxy
/// (`{port}--{hostId}.localhost:{previewProxyPort}`), passing the workspace
/// folder as the `?folder=` query parameter. Mirrored inline in the frontend
/// client (like `getEditorPath`), so it is not part of generate_types.
#[derive(Debug, Serialize)]
pub struct EditorServerInfo {
    pub port: u16,
}

pub async fn ensure_editor_server(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<EditorServerInfo>>, ApiError> {
    let port = deployment
        .openvscode()
        .ensure()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    Ok(ResponseJson(ApiResponse::success(EditorServerInfo {
        port,
    })))
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/editor-server/ensure", post(ensure_editor_server))
}
