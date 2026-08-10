//! Web Push (issue #533) — endpoints de suscripción.
//!
//! * `GET /api/push/vapid-key`: entrega la public key VAPID que el navegador
//!   consume como `applicationServerKey` al llamar a `pushManager.subscribe`.
//! * `POST /api/push/subscribe`: upsert idempotente de una PushSubscription
//!   por `endpoint` (el mismo browser reinscribiéndose sobreescribe claves).
//! * `POST /api/push/unsubscribe`: baja explícita — el frontend la llama
//!   cuando el usuario apaga el toggle. El sender también da de baja cuando
//!   el push service responde 404/410, así que este endpoint es opcional
//!   pero mantiene la tabla limpia en el happy path.

use axum::{
    Json, Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::push_subscription::{CreatePushSubscription, PushSubscription};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/push/vapid-key", get(get_vapid_key))
        .route("/push/subscribe", post(subscribe))
        .route("/push/unsubscribe", post(unsubscribe))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VapidKeyResponse {
    /// Base64URL (sin padding) del public key VAPID uncompressed SEC1
    /// (65 bytes: `0x04 || x || y`). Se pasa directo al frontend como bytes
    /// para `pushManager.subscribe({ applicationServerKey })`.
    pub public_key: String,
}

async fn get_vapid_key(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<VapidKeyResponse>>, ApiError> {
    let Some(service) = deployment.web_push() else {
        // Web Push desactivado (init falló al arrancar): devolvemos el error
        // envuelto en el ApiResponse "ok" — el frontend inspecciona el body y
        // no arma la suscripción cuando no vino public_key. Fase 1 sigue
        // funcionando.
        return Ok(ResponseJson(ApiResponse::error(
            "web push disabled: VAPID key not initialized",
        )));
    };
    Ok(ResponseJson(ApiResponse::success(VapidKeyResponse {
        public_key: service.vapid_public_key_b64().to_string(),
    })))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    /// UA del browser suscribiéndose, para diagnóstico. Opcional.
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeResponse {
    /// Confirmación de éxito. El frontend no necesita el `id` — la clave
    /// primaria del punto de vista del cliente es su propio `endpoint`.
    pub ok: bool,
}

async fn subscribe(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<SubscribeRequest>,
) -> Result<ResponseJson<ApiResponse<SubscribeResponse>>, ApiError> {
    // Sanidad mínima — el push service del vendor rechaza el resto por
    // nosotros, no vamos a re-validar formato de p256dh / auth acá.
    if req.endpoint.trim().is_empty() {
        return Err(ApiError::BadRequest("endpoint required".to_string()));
    }
    if !req.endpoint.starts_with("https://") {
        return Err(ApiError::BadRequest("endpoint must be https".to_string()));
    }

    PushSubscription::upsert(
        &deployment.db().pool,
        &CreatePushSubscription {
            endpoint: req.endpoint.clone(),
            p256dh: req.p256dh,
            auth: req.auth,
            user_agent: req.user_agent,
        },
    )
    .await?;

    tracing::info!(endpoint = %req.endpoint, "push subscription upserted");
    Ok(ResponseJson(ApiResponse::success(SubscribeResponse {
        ok: true,
    })))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnsubscribeRequest {
    pub endpoint: String,
}

async fn unsubscribe(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<UnsubscribeRequest>,
) -> Result<ResponseJson<ApiResponse<SubscribeResponse>>, ApiError> {
    if req.endpoint.trim().is_empty() {
        return Err(ApiError::BadRequest("endpoint required".to_string()));
    }

    let removed =
        PushSubscription::delete_by_endpoint(&deployment.db().pool, &req.endpoint).await?;
    tracing::info!(
        endpoint = %req.endpoint,
        removed,
        "push subscription unsubscribe"
    );
    Ok(ResponseJson(ApiResponse::success(SubscribeResponse {
        ok: true,
    })))
}
