//! Snapshot de uso para el heartbeat (fase 5b).
//!
//! Arma el [`UsageSnapshot`] que la instancia reporta al control plane. La
//! fuente es la misma que el panel de "valor generado" (`value-generated/
//! summary`): tickets que llegaron a `done` con `completed_at` seteado —el
//! registro durable de trabajo entregado— para que la base de facturación sea
//! una sola y consistente entre lo que ve el cliente y lo que se factura.
//!
//! Los contadores son **acumulativos**: el control plane calcula el consumo del
//! período restando snapshots, así un corte de conectividad no pierde nada.

use chrono::Utc;
use heartbeat_protocol::UsageSnapshot;
use sqlx::SqlitePool;

/// Cuenta tickets cerrados (acumulado y mes en curso) y arma el snapshot.
///
/// Mismo criterio que `value_generated_summary`: `status = 'done'` con
/// `completed_at` no nulo. El corte del mes usa `start of month` en UTC, igual
/// que la agregación del panel, para que el número del mes coincida.
pub async fn build_usage_snapshot(pool: &SqlitePool) -> Result<UsageSnapshot, sqlx::Error> {
    let tickets_done_total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_tasks \
         WHERE status = 'done' AND completed_at IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;

    let tickets_done_current_month: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_tasks \
         WHERE status = 'done' AND completed_at IS NOT NULL \
           AND completed_at >= datetime('now', 'start of month')",
    )
    .fetch_one(pool)
    .await?;

    Ok(UsageSnapshot {
        tickets_done_total,
        tickets_done_current_month,
        snapshot_at: Utc::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pool en memoria con las migraciones aplicadas y FKs apagadas: el test se
    /// enfoca en el conteo, sin arrastrar fixtures de worker/repo.
    ///
    /// `max_connections(1)`: una DB `:memory:` es por-conexión, así que un pool
    /// multi-conexión correría las migraciones en una y las queries en otra
    /// (vacía). Con una sola conexión, además, el `PRAGMA foreign_keys = OFF`
    /// persiste para todas las queries.
    async fn test_pool() -> SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;

        // Una sola conexión: `:memory:` es por-conexión, y así el PRAGMA de
        // abajo persiste para todas las queries del test.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open pool");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("migrate");
        // DESPUÉS de migrar: varias migraciones hacen `PRAGMA foreign_keys = ON`,
        // así que apagarlas antes no sirve. El test inserta worker_tasks sin
        // crear el worker/repo padre; sin FKs eso alcanza para probar el conteo.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("fk off");
        pool
    }

    async fn insert_task(pool: &SqlitePool, status: &str, completed_sql: &str) {
        let sql = format!(
            "INSERT INTO worker_tasks \
             (id, worker_id, repo_id, position, title, prompt, status, completed_at) \
             VALUES (randomblob(16), randomblob(16), randomblob(16), 0, 't', 'p', '{status}', {completed_sql})"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(pool)
            .await
            .expect("insert task");
    }

    #[tokio::test]
    async fn cuenta_done_acumulado_y_del_mes_en_curso() {
        let pool = test_pool().await;

        // Dos cerrados este mes, uno cerrado hace dos meses, uno en cola.
        insert_task(&pool, "done", "datetime('now')").await;
        insert_task(&pool, "done", "datetime('now', '-1 day')").await;
        insert_task(&pool, "done", "datetime('now', '-2 months')").await;
        insert_task(&pool, "queued", "NULL").await;

        let snap = build_usage_snapshot(&pool).await.expect("snapshot");

        // Acumulado = todos los done con completed_at (3). El de cola no cuenta.
        assert_eq!(snap.tickets_done_total, 3);
        // Mes en curso = solo los de este mes (2).
        assert_eq!(snap.tickets_done_current_month, 2);
    }

    #[tokio::test]
    async fn base_vacia_da_cero_sin_fallar() {
        let pool = test_pool().await;
        let snap = build_usage_snapshot(&pool).await.expect("snapshot");
        assert_eq!(snap.tickets_done_total, 0);
        assert_eq!(snap.tickets_done_current_month, 0);
    }

    #[tokio::test]
    async fn un_done_sin_completed_at_no_cuenta() {
        // Guarda contra un ticket marcado done cuyo trigger no corrió: sin
        // completed_at no debe entrar en la facturación.
        let pool = test_pool().await;
        insert_task(&pool, "done", "NULL").await;
        let snap = build_usage_snapshot(&pool).await.expect("snapshot");
        assert_eq!(snap.tickets_done_total, 0);
    }
}
