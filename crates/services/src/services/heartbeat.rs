//! Arranque del reporte a tetherpad: push periodico de contadores + task de
//! heartbeat del SDK.
//!
//! **Opt-in**: el heartbeat solo corre si `TETHERPAD_CONTROL_PLANE_URL` esta
//! configurada (lo decide el SDK). Los contadores se empujan igual: son
//! locales y gratis, y asi el primer heartbeat que se active ya reporta.

use std::time::Duration;

use db::DBService;

/// Cadencia del push de contadores. La fuente (tickets done) cambia en escala
/// humana; una hora sobra y el primer push es inmediato.
const COUNTERS_EVERY: Duration = Duration::from_secs(3600);

/// Lanza el push de contadores y el heartbeat del SDK.
pub fn spawn(db: DBService) {
    let rt = super::licensing::global().clone();

    tokio::spawn(async move {
        // Primer push antes de largar el heartbeat: el primer reporte ya
        // lleva contadores en vez de un mapa vacio.
        push_counters(&db, &rt).await;
        let _ = rt.spawn_heartbeat();
        loop {
            tokio::time::sleep(COUNTERS_EVERY).await;
            push_counters(&db, &rt).await;
        }
    });
}

async fn push_counters(db: &DBService, rt: &tetherpad_runtime::Runtime) {
    match super::usage::tickets_done_total(&db.pool).await {
        Ok(n) => rt.set_counter("tickets_done_total", n),
        Err(e) => tracing::warn!("no se pudo calcular el contador de tickets: {e}"),
    }
}
