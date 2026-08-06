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

use std::str::FromStr;

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

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
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
/// devuelve la respuesta del control plane.
///
/// La renovación de licencia (firmar y devolver `license`) se conecta cuando
/// exista la clave de firma online; por ahora la respuesta es vacía: el control
/// plane registra el heartbeat pero no renueva todavía. Eso NO deja sin servicio
/// a nadie — la licencia offline vigente corre hasta su vencimiento.
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

    Ok(Json(HeartbeatResponse::empty()))
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

    #[tokio::test]
    async fn heartbeat_valido_devuelve_200_y_persiste() {
        let pool = test_pool().await;
        let app = router(AppState { pool: pool.clone() });

        let status = post_heartbeat(app, &sample(PROTOCOL_VERSION)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(db::count_heartbeats(&pool, "01ABC").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn version_de_protocolo_desconocida_es_400() {
        let pool = test_pool().await;
        let app = router(AppState { pool: pool.clone() });

        let status = post_heartbeat(app, &sample(999)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // No debe haberse persistido nada.
        assert_eq!(db::count_heartbeats(&pool, "01ABC").await.unwrap(), 0);
    }
}
