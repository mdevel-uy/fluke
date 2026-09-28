//! Settings endpoints for the optional codegraph MCP integration: report
//! whether the binary is installed and run the official installer on demand.

use std::process::Stdio;

use axum::{
    Router,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::{process::Command, sync::Mutex};
use ts_rs::TS;
use utils::{
    codegraph::codegraph_path, command_ext::NoWindowExt, response::ApiResponse,
    shell::resolve_executable_path,
};

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/codegraph/status", get(get_status))
        .route("/codegraph/install", post(install))
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CodegraphStatus {
    pub installed: bool,
    pub path: Option<String>,
}

async fn status() -> CodegraphStatus {
    let path = codegraph_path().await;
    CodegraphStatus {
        installed: path.is_some(),
        path: path.map(|p| p.display().to_string()),
    }
}

async fn get_status() -> ResponseJson<ApiResponse<CodegraphStatus>> {
    ResponseJson(ApiResponse::success(status().await))
}

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

/// Runs the upstream installer (a self-contained bundle into the user's home,
/// no admin rights, no Node required).
async fn install() -> Result<ResponseJson<ApiResponse<CodegraphStatus>>, ApiError> {
    let _guard = INSTALL_LOCK.lock().await;
    if codegraph_path().await.is_some() {
        return Ok(ResponseJson(ApiResponse::success(status().await)));
    }

    let mut cmd = if cfg!(windows) {
        let powershell = resolve_executable_path("powershell.exe")
            .await
            .unwrap_or_else(|| "powershell.exe".into());
        let mut c = Command::new(powershell);
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex",
        ]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args([
            "-c",
            "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
        ]);
        c
    };
    let out = cmd
        .env("CODEGRAPH_TELEMETRY", "0")
        .stdin(Stdio::null())
        .no_window()
        .output()
        .await
        .map_err(|e| ApiError::BadGateway(format!("could not run the codegraph installer: {e}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(ApiError::BadGateway(format!(
            "codegraph installer failed: {}",
            tail.join("\n")
        )));
    }

    let status = status().await;
    if !status.installed {
        return Err(ApiError::BadGateway(
            "codegraph installer finished but the binary was not found".to_string(),
        ));
    }
    Ok(ResponseJson(ApiResponse::success(status)))
}
