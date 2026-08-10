//! Web Push (issue #533, fase 2 de alertas de escritorio).
//!
//! El navegador registra una suscripción push contra el servicio del vendor
//! (FCM/Mozilla/WNS), la persiste en `push_subscriptions` y el backend le
//! envía notificaciones aunque no haya ninguna pestaña abierta. La entrega
//! es best-effort: fallas de red no afectan la operación que las originó
//! (mismo criterio que el resto de side-effects del server).
//!
//! Fanout: cada evento se manda a **todas** las suscripciones registradas —
//! un mismo usuario puede tener el navegador abierto en varios dispositivos y
//! cada uno tiene su propia sub. La deduplicación con la fase 1 (app abierta
//! y visible) se hace en el service worker consultando `clients.matchAll()`
//! antes de mostrar la notificación.
//!
//! Baja de sub: el sender borra la fila cuando el push service responde
//! 404/410 ("endpoint gone" — el navegador desinstaló la sub). Otros errores
//! se loguean y la fila queda para el siguiente evento.

use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use db::{DBService, models::push_subscription::PushSubscription};
use p256::{
    SecretKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{EncodePrivateKey, LineEnding},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

/// TTL para la notificación en el push service. 4 h alcanza para las alertas
/// de tarea: si el navegador estuvo cerrado más de eso, el evento ya no es
/// relevante y el deeplink mostrará el estado actual al abrir.
const PUSH_TTL_SECONDS: u32 = 60 * 60 * 4;

/// `sub` del JWT VAPID. Los push services piden un contacto del operador —
/// no tiene que estar validado, solo presente. Usamos un mailto genérico de
/// mkanban en vez de leerlo de la config: no queremos filtrar el mail del
/// usuario al push service del vendor.
const VAPID_CONTACT: &str = "mailto:noreply@mkanban.dev";

/// Formato persistido de las claves VAPID en `web_push_vapid.json`.
/// El PEM guarda la privada (P-256, PKCS#8) — de ahí se deriva la pública
/// para servirla al frontend, así rotar la clave es solo borrar el archivo.
#[derive(Debug, Serialize, Deserialize)]
struct StoredVapidKeys {
    /// PKCS#8 PEM del secret key P-256.
    private_key_pem: String,
    /// Base64URL (sin padding) del uncompressed SEC1 (65 bytes: 0x04 || x || y).
    /// Cache — se puede regenerar desde `private_key_pem`.
    public_key_b64: String,
}

/// Cliente Web Push cargado perezosamente: la primera notificación paga la
/// generación de claves y el bootstrap del HTTP client; el resto de eventos
/// reusan el mismo `HyperWebPushClient` (pool interno de conexiones).
#[derive(Clone)]
pub struct WebPushService {
    db: DBService,
    inner: Arc<Inner>,
}

struct Inner {
    /// PEM del PKCS#8 privado — se serializa como bytes cada vez que el
    /// signer se construye (web-push acepta &[u8], no un handle reusable).
    vapid_pem: Vec<u8>,
    /// Base64URL uncompressed del public key VAPID — lo que el frontend le
    /// pasa a `pushManager.subscribe({ applicationServerKey })`.
    vapid_public_b64: String,
    /// Cliente HTTP reutilizable. Hyper mantiene el pool de conexiones
    /// internamente — un solo cliente por proceso.
    client: HyperWebPushClient,
}

impl std::fmt::Debug for WebPushService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebPushService")
            .field("vapid_public_b64", &self.inner.vapid_public_b64)
            .finish()
    }
}

/// Contenido plano que el service worker recibe y muestra como notificación.
/// Se serializa a JSON en el body encriptado — el SW parsea y hace
/// `showNotification`. `tag` se comparte con las alertas de la fase 1 para
/// que el navegador coalezca ambos caminos en un único popup por evento.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushEventPayload {
    pub title: String,
    pub body: String,
    /// Identificador estable del evento (`local-task-completed-<ws_id>`, etc).
    /// Se usa como `tag` de la notificación — reemplaza al popup previo del
    /// mismo evento en vez de amontonar duplicados.
    pub tag: String,
    /// Path relativo al que navegar en `notificationclick` (sin origin).
    pub deeplink_path: Option<String>,
}

impl WebPushService {
    /// Carga o genera las claves VAPID. El archivo se crea en la primera
    /// invocación — si falla la escritura, propaga el error hacia arriba
    /// (el servicio arranca deshabilitado en ese caso).
    pub fn load_or_generate(
        db: DBService,
        vapid_path: &std::path::Path,
    ) -> Result<Self, WebPushInitError> {
        let stored = match std::fs::read_to_string(vapid_path) {
            Ok(contents) => serde_json::from_str::<StoredVapidKeys>(&contents)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let generated = generate_vapid_keys()?;
                if let Some(parent) = vapid_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(vapid_path, serde_json::to_string_pretty(&generated)?)?;
                tracing::info!("Generated new VAPID keypair at {:?}", vapid_path);
                generated
            }
            Err(err) => return Err(err.into()),
        };

        Ok(Self {
            db,
            inner: Arc::new(Inner {
                vapid_pem: stored.private_key_pem.into_bytes(),
                vapid_public_b64: stored.public_key_b64,
                client: HyperWebPushClient::new(),
            }),
        })
    }

    /// Base64URL (no padding) del public VAPID key. El frontend lo pasa a
    /// `pushManager.subscribe({ applicationServerKey })` como raw bytes.
    pub fn vapid_public_key_b64(&self) -> &str {
        &self.inner.vapid_public_b64
    }

    fn client(&self) -> &HyperWebPushClient {
        &self.inner.client
    }

    /// Fan-out best-effort: la operación que originó el evento no debe
    /// enterarse de fallos aquí. Cualquier error se logea y sigue con la
    /// próxima suscripción; 404/410 disparan `delete_by_endpoint`.
    ///
    /// Se ejecuta en background con `tokio::spawn` desde los hooks para no
    /// bloquear el path crítico (finalize_task, on_pr_open, stuck detector).
    pub async fn notify_all(&self, payload: PushEventPayload) {
        let subs = match PushSubscription::list_all(&self.db.pool).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("web_push: failed to list subscriptions: {}", e);
                return;
            }
        };
        if subs.is_empty() {
            return;
        }
        let body = match serde_json::to_vec(&payload) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("web_push: failed to serialize payload: {}", e);
                return;
            }
        };
        tracing::debug!(
            tag = %payload.tag,
            subs = subs.len(),
            "web_push: sending event to subscriptions"
        );
        for sub in subs {
            self.send_one(&sub, &body).await;
        }
    }

    async fn send_one(&self, sub: &PushSubscription, body: &[u8]) {
        // `SubscriptionInfo::new` takes `impl Into<String>` — `&String` isn't
        // `Into<String>`, así que le pasamos las Strings clonadas. El overhead
        // es despreciable (una alocación por evento por sub) frente a la ida
        // y vuelta HTTPS al push service.
        let sub_info =
            SubscriptionInfo::new(sub.endpoint.clone(), sub.p256dh.clone(), sub.auth.clone());

        let signature =
            match VapidSignatureBuilder::from_pem(self.inner.vapid_pem.as_slice(), &sub_info) {
                Ok(mut builder) => {
                    builder.add_claim("sub", VAPID_CONTACT);
                    match builder.build() {
                        Ok(sig) => sig,
                        Err(e) => {
                            tracing::warn!(
                                endpoint = %sub.endpoint,
                                "web_push: failed to build VAPID signature: {}",
                                e
                            );
                            return;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("web_push: failed to load VAPID pem: {}", e);
                    return;
                }
            };

        let mut builder = WebPushMessageBuilder::new(&sub_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, body);
        builder.set_vapid_signature(signature);
        builder.set_ttl(PUSH_TTL_SECONDS);
        let message = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    endpoint = %sub.endpoint,
                    "web_push: failed to build message: {}",
                    e
                );
                return;
            }
        };

        let client = self.client();
        match client.send(message).await {
            Ok(()) => {
                tracing::debug!(endpoint = %sub.endpoint, "web_push: delivered");
            }
            Err(WebPushError::EndpointNotFound) | Err(WebPushError::EndpointNotValid) => {
                // El vendor confirma que la sub ya no existe. Es la única
                // señal fiable de baja: borramos la fila para que el próximo
                // evento no reintente.
                tracing::info!(
                    endpoint = %sub.endpoint,
                    "web_push: endpoint returned 404/410, deleting subscription"
                );
                if let Err(e) =
                    PushSubscription::delete_by_endpoint(&self.db.pool, &sub.endpoint).await
                {
                    tracing::warn!(
                        endpoint = %sub.endpoint,
                        "web_push: failed to delete stale subscription: {}",
                        e
                    );
                }
            }
            Err(e) => {
                // Cualquier otro error (red caída, 5xx, throttling) es
                // transitorio — no borra la sub y no propaga el error.
                tracing::warn!(
                    endpoint = %sub.endpoint,
                    "web_push: delivery failed (transient): {}",
                    e
                );
            }
        }
    }
}

/// Convenience: dispara la notificación en background sin bloquear al caller.
/// Los hooks (finalize_task, on_pr_open) llaman a esto — la operación
/// original ya está terminada y no queremos que un push lento la demore.
pub fn spawn_notify(service: WebPushService, payload: PushEventPayload) {
    tokio::spawn(async move {
        service.notify_all(payload).await;
    });
}

/// Construye los payloads de los eventos definidos en el issue #533. `tag`
/// se alinea con las alertas de fase 1 (`LocalTaskNotifications.tsx`) para
/// que el service worker pueda deduplicar consultando el `tag` del cliente
/// activo.
pub fn task_completed_payload(
    workspace_id: Uuid,
    label: &str,
    path: Option<String>,
) -> PushEventPayload {
    PushEventPayload {
        title: "Tarea terminada".to_string(),
        body: label.to_string(),
        tag: format!("local-task-completed-{workspace_id}"),
        deeplink_path: path,
    }
}

pub fn task_failed_payload(
    workspace_id: Uuid,
    label: &str,
    path: Option<String>,
) -> PushEventPayload {
    PushEventPayload {
        title: "Tarea fallada".to_string(),
        body: label.to_string(),
        tag: format!("local-task-failed-{workspace_id}"),
        deeplink_path: path,
    }
}

pub fn task_in_review_payload(
    workspace_id: Uuid,
    label: &str,
    path: Option<String>,
) -> PushEventPayload {
    PushEventPayload {
        title: "Esperando aprobación".to_string(),
        body: label.to_string(),
        tag: format!("local-task-in-review-{workspace_id}"),
        deeplink_path: path,
    }
}

pub fn task_stuck_payload(
    workspace_id: Uuid,
    label: &str,
    path: Option<String>,
) -> PushEventPayload {
    PushEventPayload {
        title: "Tarea trancada".to_string(),
        body: label.to_string(),
        tag: format!("local-task-stuck-{workspace_id}"),
        deeplink_path: path,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WebPushInitError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("pkcs8: {0}")]
    Pkcs8(String),
    #[error("public key encoding: {0}")]
    Spki(String),
}

fn generate_vapid_keys() -> Result<StoredVapidKeys, WebPushInitError> {
    let secret = SecretKey::random(&mut OsRng);
    let pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| WebPushInitError::Pkcs8(e.to_string()))?;
    let public_key = secret.public_key();

    // web-push (RFC 8292) expects raw uncompressed SEC1 (65 bytes) encoded as
    // base64url without padding — that's what browsers ingest as
    // `applicationServerKey`. `to_encoded_point(false)` yields 0x04 || x || y.
    let encoded_point = public_key.to_encoded_point(false);
    let public_key_b64 = URL_SAFE_NO_PAD.encode(encoded_point.as_bytes());

    Ok(StoredVapidKeys {
        private_key_pem: pem.to_string(),
        public_key_b64,
    })
}
