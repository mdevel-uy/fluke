use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use deployment::Deployment;
use local_deployment::openvscode::BridgeCommand;
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

/// How long the bridge extension's long-poll parks before returning empty.
/// Must stay below the extension's own request timeout (45s).
const BRIDGE_POLL_TIMEOUT: Duration = Duration::from_secs(25);

/// Connection info for the embedded openvscode-server instance. The frontend
/// builds the iframe URL from this port via the preview proxy
/// (`{port}--{hostId}.localhost:{previewProxyPort}`), passing the workspace
/// folder as the `?folder=` query parameter. Mirrored inline in the frontend
/// client (like `getEditorPath`), so it is not part of generate_types.
#[derive(Debug, Serialize)]
pub struct EditorServerInfo {
    pub port: u16,
}

#[derive(Debug, Deserialize)]
pub struct OpenFileRequest {
    pub path: String,
    pub line: Option<u32>,
}

fn bridge_base(deployment: &DeploymentImpl) -> Result<String, ApiError> {
    let addr = deployment.client_info().get_server_addr().ok_or_else(|| {
        ApiError::BadRequest("Backend address not known yet, try again".to_string())
    })?;
    // The extension host runs next to the backend, so loopback always works.
    Ok(format!("http://127.0.0.1:{}", addr.port()))
}

pub async fn ensure_editor_server(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<EditorServerInfo>>, ApiError> {
    let base = bridge_base(&deployment)?;
    let port = deployment
        .openvscode()
        .ensure(&base)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    Ok(ResponseJson(ApiResponse::success(EditorServerInfo {
        port,
    })))
}

/// Open a file inside the embedded editor (via the bridge extension).
pub async fn open_file(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<OpenFileRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    // Make sure the editor is running so the command has somewhere to land.
    let base = bridge_base(&deployment)?;
    deployment
        .openvscode()
        .ensure(&base)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    deployment
        .openvscode()
        .push_bridge_command(BridgeCommand::OpenFile {
            path: payload.path,
            line: payload.line,
        })
        .await;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Long-poll endpoint consumed by the bridge extension inside the editor.
pub async fn bridge_poll(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<Vec<BridgeCommand>>> {
    let commands = deployment
        .openvscode()
        .poll_bridge_commands(BRIDGE_POLL_TIMEOUT)
        .await;
    ResponseJson(ApiResponse::success(commands))
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/editor-server/ensure", post(ensure_editor_server))
        .route("/editor-server/open-file", post(open_file))
        .route("/editor-server/bridge/poll", get(bridge_poll))
}
