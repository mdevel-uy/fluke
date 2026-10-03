//! Detector server-side de tareas trancadas (issue #533).
//!
//! El cliente puede no estar conectado (fase 2 de las alertas: navegador
//! cerrado), así que la definición de "trancada" corre en el backend, que
//! siempre está vivo. Un proceso de ejecución en `running` cuyo `started_at`
//! es más viejo que un umbral se considera trancado y dispara una
//! notificación push única por proceso.
//!
//! Elección deliberada de "sin output nuevo" → "sin cambiar de estado en N
//! minutos": la definición ideal del issue ("output nuevo en los últimos N
//! min") requiere tocar la capa de log streaming (los logs viven en disco,
//! no en la fila `execution_processes`). Como aproximación conservadora se
//! usa el `started_at`: un agent que corre >30 min es sospechoso en la
//! práctica — bajo el modo normal de trabajo un turn completa en minutos.
//!
//! Sad path — la tarea se resuelve sola justo después: aceptable. El
//! deeplink en la notificación abre la app en el estado actual; si ya
//! terminó, el usuario ve el resultado sin ambigüedad.

use std::{collections::HashSet, sync::Arc, time::Duration};

use chrono::Utc;
use db::{
    DBService,
    models::{
        execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
        session::Session,
        workspace::Workspace,
    },
};
use tokio::{sync::Mutex, time};
use uuid::Uuid;

use crate::services::web_push::{self, WebPushService};

/// Cada cuánto barre el detector. Un minuto es suficiente: el evento no es
/// urgente (el usuario ya lleva N minutos esperando) y no queremos poblar
/// SQL con queries innecesarias.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Umbral por defecto (minutos) para considerar un proceso trancado.
/// Configurable con `FLUKE_STUCK_TASK_THRESHOLD_MINUTES`.
const DEFAULT_THRESHOLD_MINUTES: i64 = 30;

const THRESHOLD_ENV: &str = "FLUKE_STUCK_TASK_THRESHOLD_MINUTES";

/// Minutes after which a running coding agent counts as stuck. Shared with
/// the issue plan (#694), which marks the phase as needing a person.
pub fn threshold_minutes() -> i64 {
    std::env::var(THRESHOLD_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|m| *m > 0)
        .unwrap_or(DEFAULT_THRESHOLD_MINUTES)
}

pub struct StuckTaskDetector {
    db: DBService,
    web_push: WebPushService,
    threshold_minutes: i64,
    /// Procesos ya notificados en esta corrida. En memoria: al reiniciar el
    /// server se re-notifica una vez más, aceptable — reiniciar no es común.
    /// La alternativa (columna DB) suma complejidad para poca ganancia.
    notified: Arc<Mutex<HashSet<Uuid>>>,
}

impl StuckTaskDetector {
    pub fn spawn(db: DBService, web_push: WebPushService) -> tokio::task::JoinHandle<()> {
        let threshold_minutes = std::env::var(THRESHOLD_ENV)
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(DEFAULT_THRESHOLD_MINUTES);

        let detector = Self {
            db,
            web_push,
            threshold_minutes,
            notified: Arc::new(Mutex::new(HashSet::new())),
        };

        tokio::spawn(async move {
            tracing::info!(
                threshold_minutes = detector.threshold_minutes,
                "stuck_task_detector started"
            );
            // Wait once at startup so we don't fire immediately on cold
            // restart: any `running` process left by a previous run is likely
            // being reaped by cleanup_orphan_executions, not stuck.
            time::sleep(POLL_INTERVAL).await;
            loop {
                if let Err(e) = detector.tick().await {
                    tracing::warn!("stuck_task_detector: tick failed: {}", e);
                }
                time::sleep(POLL_INTERVAL).await;
            }
        })
    }

    async fn tick(&self) -> Result<(), sqlx::Error> {
        let running = ExecutionProcess::find_running(&self.db.pool).await?;
        if running.is_empty() {
            // No hay procesos corriendo → limpiar el set de notificados para
            // que si el mismo workspace vuelve a agarrar tarea y se traba,
            // la próxima vez se notifica igual.
            let mut notified = self.notified.lock().await;
            if !notified.is_empty() {
                notified.clear();
            }
            return Ok(());
        }

        let cutoff = Utc::now() - chrono::Duration::minutes(self.threshold_minutes);
        let mut notified = self.notified.lock().await;

        // Poda: procesos que ya no están running deben salir del set — así
        // no crecemos sin límite y una segunda corrida del mismo workspace
        // puede volver a notificarse si vuelve a trancarse.
        let still_running: HashSet<Uuid> = running.iter().map(|p| p.id).collect();
        notified.retain(|id| still_running.contains(id));

        for process in running {
            if process.status != ExecutionProcessStatus::Running {
                continue;
            }
            // Solo agentes de código — dev servers y setup scripts pueden
            // correr indefinidamente por diseño y no deberían disparar.
            if !matches!(process.run_reason, ExecutionProcessRunReason::CodingAgent) {
                continue;
            }
            if process.started_at > cutoff {
                continue;
            }
            if notified.contains(&process.id) {
                continue;
            }

            let session = match Session::find_by_id(&self.db.pool, process.session_id).await {
                Ok(Some(s)) => s,
                Ok(None) => continue,
                Err(e) => {
                    tracing::warn!(
                        process_id = %process.id,
                        "stuck_task_detector: failed to load session: {}",
                        e
                    );
                    continue;
                }
            };

            let workspace = match Workspace::find_by_id(&self.db.pool, session.workspace_id).await {
                Ok(Some(w)) => w,
                Ok(None) => continue,
                Err(e) => {
                    tracing::warn!(
                        workspace_id = %session.workspace_id,
                        "stuck_task_detector: failed to load workspace: {}",
                        e
                    );
                    continue;
                }
            };

            if workspace.archived {
                // Workspace ya archivado — no notificar (path-tenso: un
                // agent que quedó en running al archivar entra al cleanup
                // pipeline, no es "trancado" desde la vista del usuario).
                notified.insert(process.id);
                continue;
            }

            let label = workspace_label(&workspace);
            // El deeplink apunta al workspace; sin hostId acá — el frontend
            // resuelve el path local aceptando ambos formatos.
            let payload = web_push::task_stuck_payload(
                workspace.id,
                &label,
                Some(format!("/workspaces/{}", workspace.id)),
            );
            tracing::info!(
                workspace_id = %workspace.id,
                process_id = %process.id,
                minutes = self.threshold_minutes,
                "stuck_task_detector: notifying stuck task"
            );
            web_push::spawn_notify(self.web_push.clone(), payload);
            notified.insert(process.id);
        }

        Ok(())
    }
}

fn workspace_label(ws: &Workspace) -> String {
    ws.name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&ws.branch)
        .to_string()
}
