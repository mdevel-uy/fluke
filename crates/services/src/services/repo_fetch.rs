//! Refresco en background de los refs remote-tracking de cada repo.
//!
//! Antes el handler de branch-status hacía el `git fetch` inline. Ese fetch
//! shellea a `git` de forma síncrona y bloqueante, así que cada poll de la UI
//! —cada 5s por workspace abierto, cada 15s por workspace activo— clavaba un
//! worker thread de tokio durante todo el round-trip de red. En un host de 2
//! cores eso es el runtime entero: dos polls concurrentes congelaban el
//! servidor completo (incluido el SSE), y la UI quedaba colgada.
//!
//! La red vive acá ahora. El handler sólo lee los refs que este servicio deja
//! en disco, con `get_remote_branch_status_cached`.
//!
//! Trade-off aceptado: los contadores ahead/behind que muestra la UI pueden
//! quedar hasta `FETCH_INTERVAL` desactualizados. Es irrelevante para lo único
//! que deciden (mostrar "N commits atrás"), y la operación que sí necesita el
//! dato fresco —`rebase_branch`— fetchea por su cuenta antes de rebasar.

use std::time::Duration;

use db::{DBService, models::repo::Repo};
use git::GitService;
use tokio::time;

/// Cada cuánto se refrescan los refs. Deliberadamente más lento que el poll
/// de la UI: cada tick dispara un `git fetch` por repo y no hay ninguna
/// decisión que dependa de una precisión mayor.
const FETCH_INTERVAL: Duration = Duration::from_secs(60);

pub fn spawn(db: DBService, git: GitService) {
    tokio::spawn(async move {
        let mut ticker = time::interval(FETCH_INTERVAL);
        // El primer tick sale enseguida: al arrancar los refs pueden venir
        // viejos de la sesión anterior.
        loop {
            ticker.tick().await;
            run_once(&db, &git).await;
        }
    });
}

async fn run_once(db: &DBService, git: &GitService) {
    let repos = match Repo::list_all(&db.pool).await {
        Ok(repos) => repos,
        Err(e) => {
            tracing::warn!("repo_fetch: no se pudieron listar los repos: {e}");
            return;
        }
    };

    // Secuencial a propósito: N repos en paralelo son N conexiones salientes
    // simultáneas contra el mismo remoto, y no hay apuro por terminar el ciclo.
    for repo in repos {
        let git = git.clone();
        let path = repo.path.clone();
        let name = repo.name.clone();

        // `spawn_blocking` y no el runtime async: `fetch_all_remote_refs`
        // espera a un proceso hijo. Esta es exactamente la llamada que no
        // debe volver a un worker thread.
        let result = tokio::task::spawn_blocking(move || git.fetch_all_remote_refs(&path)).await;

        match result {
            Ok(Ok(())) => tracing::debug!("repo_fetch: refs actualizados para {name}"),
            // Un remoto caído o sin credenciales no es motivo de alarma: el
            // handler sigue sirviendo los refs previos.
            Ok(Err(e)) => tracing::debug!("repo_fetch: fetch falló para {name}: {e}"),
            Err(e) => tracing::warn!("repo_fetch: la tarea de fetch panicó para {name}: {e}"),
        }
    }
}
