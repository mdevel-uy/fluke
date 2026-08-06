//! Protocolo del heartbeat entre una instancia de mkanban y el control plane
//! (fase 5b). Tipos de la conexión, compartidos por ambos lados.
//!
//! Flujo: la instancia hace `POST /v1/heartbeat` con [`HeartbeatRequest`]
//! (identidad + versión + contadores de uso acumulativos). El control plane,
//! si el cliente está al día, responde con una licencia renovada y firmada en
//! [`HeartbeatResponse::license`]. Dejar de renovar es el kill-switch pasivo.
//!
//! **La renovación es server-authoritative** (ver LICENSING-SPEC, modelo de
//! amenaza): la fecha de vencimiento la decide el control plane, no el reloj de
//! la instancia. Por eso el request no propone un vencimiento — solo reporta
//! estado; el control plane firma el `expires_at`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Versión del protocolo. El control plane rechaza (o adapta) un `v` que no
/// reconoce en vez de malinterpretar el payload.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    pub v: u32,
    /// Identificador estable de la instalación (se genera en el primer arranque
    /// y persiste). Ata el heartbeat y la licencia a una instancia.
    pub instance_id: String,
    /// Slug del cliente, tomado de la licencia vigente. Vacío si la instancia
    /// todavía no tiene licencia (primer contacto).
    pub cliente: String,
    /// Versión del binario que está corriendo (`APP_VERSION`). Le permite al
    /// control plane ver el estado de actualización de la flota.
    pub version: String,
    /// Contadores de uso acumulativos. Ver [`UsageSnapshot`].
    pub usage: UsageSnapshot,
}

/// Contadores de uso que fundamentan la facturación (% del ahorro sobre tickets
/// cerrados). **Acumulativos, no deltas**: el control plane calcula el consumo
/// del período restando snapshots, así un corte de conectividad no pierde
/// facturación (a diferencia de reportar el delta del día, que se perdería).
///
/// La fuente es la misma que el panel de "valor generado": tickets que llegaron
/// a `done` (con `completed_at`), el registro durable de trabajo entregado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageSnapshot {
    /// Tickets cerrados (`done`) desde siempre. Monótono salvo borrado manual;
    /// el control plane hace piso en 0 al calcular deltas.
    pub tickets_done_total: i64,
    /// Tickets cerrados en el mes calendario UTC en curso. Redundante con el
    /// acumulado, pero deja al control plane mostrar el mes sin guardar todos
    /// los snapshots intermedios.
    pub tickets_done_current_month: i64,
    /// Momento en que se tomó el snapshot (UTC).
    pub snapshot_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatResponse {
    pub v: u32,
    /// Contenido de `license.json` renovado y firmado, cuando el cliente está al
    /// día. La instancia lo escribe en su data dir. `None` = no se renueva
    /// (cliente moroso, o el control plane decidió no emitir): la licencia
    /// vigente corre hasta su vencimiento y ahí degrada — kill-switch pasivo.
    pub license: Option<String>,
    /// Última versión disponible en el canal de la instancia, para orientar el
    /// updater OTA. `None` si el control plane no gestiona versiones.
    pub latest_version: Option<String>,
    /// Mensaje opcional del operador para mostrar en la UI (p. ej. aviso de
    /// pago pendiente antes de que la licencia caiga en gracia).
    pub message: Option<String>,
}

impl HeartbeatResponse {
    /// Respuesta vacía: sin renovación, sin versión, sin mensaje. Lo que
    /// devuelve un control plane que registró el heartbeat pero no tiene nada
    /// que entregar (útil como default y en tests).
    pub fn empty() -> Self {
        Self {
            v: PROTOCOL_VERSION,
            license: None,
            latest_version: None,
            message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn sample_request() -> HeartbeatRequest {
        HeartbeatRequest {
            v: PROTOCOL_VERSION,
            instance_id: "01JABCDEF".to_string(),
            cliente: "acme".to_string(),
            version: "1.0.0".to_string(),
            usage: UsageSnapshot {
                tickets_done_total: 128,
                tickets_done_current_month: 12,
                snapshot_at: Utc.with_ymd_and_hms(2026, 8, 5, 4, 17, 0).unwrap(),
            },
        }
    }

    #[test]
    fn request_roundtrip() {
        let req = sample_request();
        let json = serde_json::to_string(&req).unwrap();
        let back: HeartbeatRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn response_roundtrip_con_licencia() {
        let resp = HeartbeatResponse {
            v: PROTOCOL_VERSION,
            license: Some("{\"payload\":{},\"signature\":\"...\"}".to_string()),
            latest_version: Some("1.1.0".to_string()),
            message: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: HeartbeatResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn response_vacia_no_renueva_ni_avisa() {
        let resp = HeartbeatResponse::empty();
        assert!(resp.license.is_none());
        assert!(resp.latest_version.is_none());
        assert!(resp.message.is_none());
        assert_eq!(resp.v, PROTOCOL_VERSION);
    }

    #[test]
    fn el_snapshot_es_estable_a_traves_de_serde() {
        // Los contadores son la base de facturación: un roundtrip no debe
        // alterarlos ni perder precisión del timestamp.
        let snap = sample_request().usage;
        let json = serde_json::to_string(&snap).unwrap();
        let back: UsageSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snap.tickets_done_total, back.tickets_done_total);
        assert_eq!(snap.snapshot_at, back.snapshot_at);
    }
}
