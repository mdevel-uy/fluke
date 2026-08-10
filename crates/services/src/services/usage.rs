//! Fuente de metering de mkanban: tickets que llegaron a `done`.
//!
//! Es la implementacion mkanban de las claves declaradas en la definicion del
//! producto (`x-tetherpad.metering` en ops/onprem/docker-compose.yml). La
//! fuente es la misma que el panel de "valor generado": tickets con
//! `completed_at` seteado — el registro durable de trabajo entregado — para
//! que la base de facturacion sea una sola y consistente.
//!
//! El contador es **acumulativo desde siempre** (contrato de tetherpad v1:
//! acumulativos estrictos). El corte por mes lo deriva el control plane
//! restando snapshots; aca no se reporta nada no monotono.

use sqlx::SqlitePool;

/// Tickets cerrados (`done` con `completed_at`) desde siempre. Mismo criterio
/// que `value_generated_summary`.
pub async fn tickets_done_total(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM worker_tasks \
         WHERE status = 'done' AND completed_at IS NOT NULL",
    )
    .fetch_one(pool)
    .await
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
        sqlx::query(&sql).execute(pool).await.expect("insert task");
    }

    #[tokio::test]
    async fn cuenta_solo_los_done_con_completed_at() {
        let pool = test_pool().await;

        insert_task(&pool, "done", "datetime('now')").await;
        insert_task(&pool, "done", "datetime('now', '-2 months')").await;
        insert_task(&pool, "done", "NULL").await; // trigger que no corrió: no cuenta
        insert_task(&pool, "queued", "NULL").await;

        assert_eq!(tickets_done_total(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn base_vacia_da_cero_sin_fallar() {
        let pool = test_pool().await;
        assert_eq!(tickets_done_total(&pool).await.unwrap(), 0);
    }
}
