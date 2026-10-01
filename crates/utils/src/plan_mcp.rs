//! Servidores MCP propios de fluke, servidos por HTTP por el mismo servidor:
//! - plan: el agente declara y recorre su plan (`/api/plan-mcp/{workspace_id}`).
//! - director: las herramientas del Director (`/api/director-mcp/{session_id}`).
//!
//! El puerto se conoce recién cuando el servidor arranca, así que queda en un
//! global que setea `startup` y lee el executor al armar el `--mcp-config`.

use std::{net::SocketAddr, path::PathBuf, sync::OnceLock};

/// Env var que el container le pasa al executor con la URL del MCP de plan
/// de ese workspace. Si no está, el agente corre sin plan.
pub const PLAN_MCP_URL_ENV: &str = "FLUKE_PLAN_MCP_URL";

/// Prefijo de las herramientas tal como las ve el agente.
pub const TOOL_PREFIX: &str = "mcp__fluke_plan__";

/// Env var con la URL del MCP del Director. Solo la tienen las sesiones de
/// una misión; con ella el executor también recorta herramientas de edición.
pub const DIRECTOR_MCP_URL_ENV: &str = "FLUKE_DIRECTOR_MCP_URL";

/// Env var con el system prompt del Director (instrucciones + soul).
pub const DIRECTOR_PROMPT_ENV: &str = "FLUKE_DIRECTOR_PROMPT";

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

pub fn director_url_for_session(session_id: &str) -> Option<String> {
    let port = SERVER_ADDR.get()?.port();
    Some(format!(
        "http://127.0.0.1:{port}/api/director-mcp/{session_id}"
    ))
}

/// Escribe el `--mcp-config` para una URL de plan. Un archivo por workspace
/// porque varios agentes corren en paralelo.
pub async fn mcp_config_file(url: &str) -> Option<PathBuf> {
    write_config("fluke_plan", "plan-mcp", url).await
}

/// Igual que [`mcp_config_file`] para el MCP del Director (uno por sesión).
pub async fn director_mcp_config_file(url: &str) -> Option<PathBuf> {
    write_config("fluke_director", "director-mcp", url).await
}

async fn write_config(server: &str, dir_name: &str, url: &str) -> Option<PathBuf> {
    let key = url.rsplit('/').next().unwrap_or("default");
    let config = serde_json::json!({
        "mcpServers": { server: { "type": "http", "url": url } }
    });
    let dir = crate::assets::asset_dir().join(dir_name);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("{dir_name}: could not create {dir:?}: {e}");
        return None;
    }
    let path = dir.join(format!("{key}.json"));
    match tokio::fs::write(&path, config.to_string()).await {
        Ok(()) => Some(path),
        Err(e) => {
            tracing::warn!("{dir_name}: could not write MCP config {path:?}: {e}");
            None
        }
    }
}

/// Escribe el system prompt del Director a un archivo, para pasarlo con
/// `--append-system-prompt-file` (un texto largo con saltos de línea no
/// sobrevive como argumento cuando el CLI se lanza por un shim `.cmd`).
pub async fn director_prompt_file(url: &str, prompt: &str) -> Option<PathBuf> {
    let key = url.rsplit('/').next().unwrap_or("default");
    let dir = crate::assets::asset_dir().join("director-mcp");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("director-mcp: could not create {dir:?}: {e}");
        return None;
    }
    let path = dir.join(format!("{key}.prompt.md"));
    match tokio::fs::write(&path, prompt).await {
        Ok(()) => Some(path),
        Err(e) => {
            tracing::warn!("director-mcp: could not write prompt {path:?}: {e}");
            None
        }
    }
}
