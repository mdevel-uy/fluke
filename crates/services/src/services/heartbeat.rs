//! Task de heartbeat del cliente (fase 5b).
//!
//! Periódicamente reporta al control plane la identidad de la instancia, su
//! versión y los contadores de uso (para facturación), y aplica la licencia
//! renovada que el control plane devuelve cuando el cliente está al día.
//!
//! **Opt-in**: solo corre si está configurada la URL del control plane
//! (`MKANBAN_CONTROL_PLANE_URL`). Sin ella no se hace ningún request — la flota
//! actual no reporta a ningún lado hasta que se configure.
//!
//! El heartbeat reporta uso aunque el licenciamiento no esté activo (sin clave
//! embebida): los contadores sirven para facturación independientemente del
//! enforcement.

use std::time::Duration;

use db::DBService;
use heartbeat_protocol::{HeartbeatRequest, HeartbeatResponse, PROTOCOL_VERSION};
use utils::version::APP_VERSION;

const CONTROL_PLANE_URL_ENV: &str = "MKANBAN_CONTROL_PLANE_URL";
/// Token de ingesta (opcional). Viene en el bundle del cliente; el control
/// plane lo usa para auto-vincular la instancia al cliente comercial en el
/// primer heartbeat (provisioning sin aprobación manual). Sin token, la
/// instancia entra "pendiente" y un operador la aprueba desde el panel.
const INGEST_TOKEN_ENV: &str = "MKANBAN_INGEST_TOKEN";
/// Header en el que viaja el token (contrato con el control plane).
const INGEST_HEADER: &str = "x-mkanban-ingest";

/// Cada cuánto se emite el heartbeat cuando el anterior fue bien.
const INTERVAL_OK: Duration = Duration::from_secs(24 * 3600);
/// Reintento más corto tras un fallo (red caída, control plane no disponible).
const INTERVAL_RETRY: Duration = Duration::from_secs(3600);

/// Lanza la task en segundo plano. No hace nada si la URL no está configurada.
pub fn spawn(db: DBService) {
    let url = match std::env::var(CONTROL_PLANE_URL_ENV) {
        Ok(u) if !u.trim().is_empty() => u.trim().trim_end_matches('/').to_string(),
        _ => {
            tracing::debug!("heartbeat desactivado (sin {CONTROL_PLANE_URL_ENV})");
            return;
        }
    };

    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        tracing::info!("heartbeat activo → {url}");
        loop {
            let wait = match tick(&db, &client, &url).await {
                Ok(()) => INTERVAL_OK,
                Err(e) => {
                    tracing::warn!("heartbeat falló: {e}");
                    INTERVAL_RETRY
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

async fn tick(db: &DBService, client: &reqwest::Client, url: &str) -> anyhow::Result<()> {
    let usage = crate::services::usage::build_usage_snapshot(&db.pool).await?;
    let instance_id = utils::assets::instance_id()?;
    let cliente = read_cliente().unwrap_or_default();

    let req = HeartbeatRequest {
        v: PROTOCOL_VERSION,
        instance_id,
        cliente,
        version: APP_VERSION.to_string(),
        usage,
    };

    let mut request = client.post(format!("{url}/v1/heartbeat")).json(&req);
    if let Ok(token) = std::env::var(INGEST_TOKEN_ENV) {
        let token = token.trim();
        if !token.is_empty() {
            request = request.header(INGEST_HEADER, token);
        }
    }
    let resp: HeartbeatResponse = request
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    if let Some(license) = resp.license {
        // Escribir la licencia renovada y re-evaluar. El LicenseService la lee
        // de este mismo path; el refresh actualiza el estado del gate/banner.
        std::fs::write(utils::assets::license_path(), &license)?;
        crate::services::licensing::global().refresh();
        tracing::info!("licencia renovada por el control plane");
    }

    Ok(())
}

/// Lee el `cliente` de la licencia vigente, si hay una. Es informativo (el
/// control plane identifica por `instance_id`), así que se parsea sin verificar
/// la firma: reportar un cliente no autentica nada.
fn read_cliente() -> Option<String> {
    let raw = std::fs::read_to_string(utils::assets::license_path()).ok()?;
    let file: licensing::LicenseFile = serde_json::from_str(&raw).ok()?;
    Some(file.payload.cliente)
}
