//! Servidor MCP de plan: el agente declara y recorre su plan por HTTP contra
//! el propio servidor de fluke (`/api/plan-mcp/{workspace_id}`).
//!
//! El puerto se conoce recién cuando el servidor arranca, así que queda en un
//! global que setea `startup` y lee el executor al armar el `--mcp-config`.

use std::{net::SocketAddr, path::PathBuf, sync::OnceLock};

/// Env var que el container le pasa al executor con la URL del MCP de plan
/// de ese workspace. Si no está, el agente corre sin plan.
pub const PLAN_MCP_URL_ENV: &str = "FLUKE_PLAN_MCP_URL";

/// Prefijo de las herramientas tal como las ve el agente.
pub const TOOL_PREFIX: &str = "mcp__fluke_plan__";

static SERVER_ADDR: OnceLock<SocketAddr> = OnceLock::new();

pub fn set_server_addr(addr: SocketAddr) {
    let _ = SERVER_ADDR.set(addr);
}

pub fn url_for_workspace(workspace_id: &str) -> Option<String> {
    let port = SERVER_ADDR.get()?.port();
    Some(format!(
        "http://127.0.0.1:{port}/api/plan-mcp/{workspace_id}"
    ))
}

/// Escribe el `--mcp-config` para una URL de plan. Un archivo por workspace
/// porque varios agentes corren en paralelo.
pub async fn mcp_config_file(url: &str) -> Option<PathBuf> {
    let workspace = url.rsplit('/').next().unwrap_or("default");
    let config = serde_json::json!({
        "mcpServers": { "fluke_plan": { "type": "http", "url": url } }
    });
    let dir = crate::assets::asset_dir().join("plan-mcp");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("plan-mcp: could not create {dir:?}: {e}");
        return None;
    }
    let path = dir.join(format!("{workspace}.json"));
    match tokio::fs::write(&path, config.to_string()).await {
        Ok(()) => Some(path),
        Err(e) => {
            tracing::warn!("plan-mcp: could not write MCP config {path:?}: {e}");
            None
        }
    }
}
