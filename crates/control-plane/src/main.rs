use control_plane::{AppState, init_pool, router};

/// Config por variables de entorno:
///   CONTROL_PLANE_DB   ruta del archivo sqlite (default control-plane.db)
///   CONTROL_PLANE_ADDR bind (default 0.0.0.0:8080)
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let db_path =
        std::env::var("CONTROL_PLANE_DB").unwrap_or_else(|_| "control-plane.db".to_string());
    let addr =
        std::env::var("CONTROL_PLANE_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

    let pool = init_pool(&format!("sqlite://{db_path}")).await?;
    let signer = control_plane::signing::LicenseSigner::from_env()?.map(std::sync::Arc::new);
    if signer.is_some() {
        tracing::info!("clave de firma online cargada: la renovación está activa");
    } else {
        tracing::warn!("sin clave de firma online: se registran heartbeats pero no se renueva");
    }
    let app = router(AppState { pool, signer });

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("control plane escuchando en {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
