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
    let app = router(AppState { pool });

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("control plane escuchando en {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
