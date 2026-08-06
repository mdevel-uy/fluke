//! Control plane de mdevel (fase 5b).
//!
//! Recibe los heartbeats de las instancias, los persiste (estado más reciente +
//! historia append-only), y responde con la licencia renovada cuando el cliente
//! está al día. La renovación es **server-authoritative**: la fecha de
//! vencimiento la firma el control plane, no la propone la instancia.
//!
//! Superficies:
//! * `/v1/*` — ingesta máquina-a-máquina (instancias posteando). Pública en el
//!   sentido de que no hay login humano; la identidad es el `instance_id`.
//! * `/admin/*` — fase 2, gestión humana de la flota. Va detrás de Auth0 con
//!   RBAC (viewer / operator). Todavía no implementada.

use std::{str::FromStr, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use heartbeat_protocol::{HeartbeatRequest, HeartbeatResponse, PROTOCOL_VERSION};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

pub mod db;
pub mod signing;

use signing::LicenseSigner;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    /// Firmador de la clave online. `None` cuando no está configurada: el
    /// control plane registra heartbeats pero no renueva (no deja sin servicio
    /// a nadie — la licencia offline vigente corre hasta vencer).
    pub signer: Option<Arc<LicenseSigner>>,
}

/// Abre (creando si hace falta) la base del control plane y corre migraciones.
pub async fn init_pool(database_url: &str) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/heartbeat", post(heartbeat))
        .with_state(state)
}

/// Ingesta de un heartbeat. Persiste el estado de la instancia y su snapshot, y
/// —si la clave online está configurada y la instancia está al día— devuelve una
/// licencia renovada y firmada.
///
/// La renovación es **server-authoritative**: el vencimiento lo fija el control
/// plane. Dejar de renovar (flag `paid = 0`, o clave no configurada) es el
/// kill-switch pasivo: no deja sin servicio de golpe, la licencia vigente corre
/// hasta vencer.
async fn heartbeat(
    State(state): State<AppState>,
    Json(req): Json<HeartbeatRequest>,
) -> Result<Json<HeartbeatResponse>, StatusCode> {
    if req.v != PROTOCOL_VERSION {
        return Err(StatusCode::BAD_REQUEST);
    }

    db::record_heartbeat(&state.pool, &req).await.map_err(|e| {
        tracing::error!("no se pudo registrar el heartbeat: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let mut resp = HeartbeatResponse::empty();

    // Renovación: solo si hay clave online configurada y la instancia figura al
    // día. `paid` lo gobierna un operador desde la superficie admin (fase 2).
    if let Some(signer) = &state.signer {
        let paid = db::get_instance(&state.pool, &req.instance_id)
            .await
            .map_err(|e| {
                tracing::error!("no se pudo leer la instancia: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            })?
            .map(|i| i.paid != 0)
            .unwrap_or(false);

        if paid {
            // modalidad es informativa en la licencia; onprem por defecto hasta
            // que el aprovisionamiento (fase 2) la registre por instancia.
            resp.license = Some(signer.sign_renewal(
                &req.cliente,
                &req.instance_id,
                "onprem",
                chrono::Utc::now(),
            ));
        }
    }

    Ok(Json(resp))
}

/// Helper para tests: pool en memoria migrado.
#[doc(hidden)]
pub async fn test_pool() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("pool");
    sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
    pool
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use chrono::Utc;
    use heartbeat_protocol::{HeartbeatRequest, UsageSnapshot};
    use tower::ServiceExt; // oneshot

    use super::*;

    fn sample(v: u32) -> HeartbeatRequest {
        HeartbeatRequest {
            v,
            instance_id: "01ABC".into(),
            cliente: "acme".into(),
            version: "1.0.0".into(),
            usage: UsageSnapshot {
                tickets_done_total: 7,
                tickets_done_current_month: 2,
                snapshot_at: Utc::now(),
            },
        }
    }

    async fn post_heartbeat(app: Router, req: &HeartbeatRequest) -> StatusCode {
        let body = serde_json::to_string(req).unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/heartbeat")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        response.status()
    }

    async fn post_heartbeat_full(
        app: Router,
        req: &HeartbeatRequest,
    ) -> (StatusCode, HeartbeatResponse) {
        let body = serde_json::to_string(req).unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/heartbeat")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: HeartbeatResponse = serde_json::from_slice(&bytes).unwrap();
        (status, parsed)
    }

    #[tokio::test]
    async fn heartbeat_valido_devuelve_200_y_persiste() {
        let pool = test_pool().await;
        let app = router(AppState { pool: pool.clone(), signer: None });

        let status = post_heartbeat(app, &sample(PROTOCOL_VERSION)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(db::count_heartbeats(&pool, "01ABC").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn version_de_protocolo_desconocida_es_400() {
        let pool = test_pool().await;
        let app = router(AppState { pool: pool.clone(), signer: None });

        let status = post_heartbeat(app, &sample(999)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // No debe haberse persistido nada.
        assert_eq!(db::count_heartbeats(&pool, "01ABC").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn sin_clave_configurada_no_renueva() {
        let pool = test_pool().await;
        let app = router(AppState { pool, signer: None });
        let (status, resp) = post_heartbeat_full(app, &sample(PROTOCOL_VERSION)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(resp.license.is_none());
    }

    #[tokio::test]
    async fn instancia_al_dia_recibe_licencia_renovada_que_verifica() {
        use ed25519_dalek::SigningKey;
        use licensing::verify;
        use rand::rngs::OsRng;

        let pool = test_pool().await;
        let key = SigningKey::generate(&mut OsRng);
        let pubkey = key.verifying_key();
        let signer = std::sync::Arc::new(signing::LicenseSigner::with_key(key, 35));
        let app = router(AppState { pool, signer: Some(signer) });

        let (status, resp) = post_heartbeat_full(app, &sample(PROTOCOL_VERSION)).await;
        assert_eq!(status, StatusCode::OK);

        // La instancia es nueva → paid default 1 → debe venir una licencia, y
        // debe verificar contra la clave online (como haría el cliente).
        let license = resp.license.expect("debe renovar");
        let payload = verify(&license, &[pubkey]).expect("la renovación verifica");
        assert_eq!(payload.instance_id, "01ABC");
    }
}
