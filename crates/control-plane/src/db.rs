//! Persistencia del control plane.

use heartbeat_protocol::HeartbeatRequest;
use sqlx::SqlitePool;

/// Registra un heartbeat: actualiza el estado más reciente de la instancia
/// (upsert) y agrega una fila a la historia append-only. Ambas cosas en una
/// transacción para que el estado y la historia no queden desalineados.
pub async fn record_heartbeat(pool: &SqlitePool, req: &HeartbeatRequest) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let snapshot_at = req.usage.snapshot_at.to_rfc3339();

    // Upsert del estado más reciente. `first_seen`, `paid` y demás defaults se
    // conservan en el conflicto: solo se refrescan los campos que cambian.
    sqlx::query(
        "INSERT INTO instances \
             (instance_id, cliente, version, tickets_done_total, tickets_done_current_month, snapshot_at, last_seen) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', 'subsec')) \
         ON CONFLICT(instance_id) DO UPDATE SET \
             cliente = excluded.cliente, \
             version = excluded.version, \
             tickets_done_total = excluded.tickets_done_total, \
             tickets_done_current_month = excluded.tickets_done_current_month, \
             snapshot_at = excluded.snapshot_at, \
             last_seen = datetime('now', 'subsec')",
    )
    .bind(&req.instance_id)
    .bind(&req.cliente)
    .bind(&req.version)
    .bind(req.usage.tickets_done_total)
    .bind(req.usage.tickets_done_current_month)
    .bind(&snapshot_at)
    .execute(&mut *tx)
    .await?;

    // Historia.
    sqlx::query(
        "INSERT INTO heartbeats \
             (instance_id, version, tickets_done_total, tickets_done_current_month, snapshot_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&req.instance_id)
    .bind(&req.version)
    .bind(req.usage.tickets_done_total)
    .bind(req.usage.tickets_done_current_month)
    .bind(&snapshot_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Estado más reciente de una instancia (para tests y, más adelante, la
/// superficie admin).
#[derive(Debug, sqlx::FromRow, PartialEq)]
pub struct InstanceRow {
    pub instance_id: String,
    pub cliente: String,
    pub version: String,
    pub tickets_done_total: i64,
    pub tickets_done_current_month: i64,
    pub paid: i64,
}

pub async fn get_instance(
    pool: &SqlitePool,
    instance_id: &str,
) -> Result<Option<InstanceRow>, sqlx::Error> {
    sqlx::query_as::<_, InstanceRow>(
        "SELECT instance_id, cliente, version, tickets_done_total, \
                tickets_done_current_month, paid \
         FROM instances WHERE instance_id = ?1",
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await
}

pub async fn count_heartbeats(pool: &SqlitePool, instance_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE instance_id = ?1")
        .bind(instance_id)
        .fetch_one(pool)
        .await
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use heartbeat_protocol::{PROTOCOL_VERSION, UsageSnapshot};

    use super::*;
    use crate::test_pool;

    fn req(instance: &str, total: i64, month: i64) -> HeartbeatRequest {
        HeartbeatRequest {
            v: PROTOCOL_VERSION,
            instance_id: instance.to_string(),
            cliente: "acme".to_string(),
            version: "1.0.0".to_string(),
            usage: UsageSnapshot {
                tickets_done_total: total,
                tickets_done_current_month: month,
                snapshot_at: Utc::now(),
            },
        }
    }

    #[tokio::test]
    async fn primer_heartbeat_crea_la_instancia() {
        let pool = test_pool().await;
        record_heartbeat(&pool, &req("01ABC", 10, 3)).await.unwrap();

        let inst = get_instance(&pool, "01ABC").await.unwrap().unwrap();
        assert_eq!(inst.cliente, "acme");
        assert_eq!(inst.tickets_done_total, 10);
        assert_eq!(inst.paid, 1); // default al día
        assert_eq!(count_heartbeats(&pool, "01ABC").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn heartbeats_sucesivos_actualizan_estado_y_acumulan_historia() {
        let pool = test_pool().await;
        record_heartbeat(&pool, &req("01ABC", 10, 3)).await.unwrap();
        record_heartbeat(&pool, &req("01ABC", 25, 8)).await.unwrap();

        let inst = get_instance(&pool, "01ABC").await.unwrap().unwrap();
        // El estado refleja el último snapshot.
        assert_eq!(inst.tickets_done_total, 25);
        assert_eq!(inst.tickets_done_current_month, 8);
        // La historia conserva ambos (base para el delta del período).
        assert_eq!(count_heartbeats(&pool, "01ABC").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn instancias_distintas_no_se_pisan() {
        let pool = test_pool().await;
        record_heartbeat(&pool, &req("a", 5, 5)).await.unwrap();
        record_heartbeat(&pool, &req("b", 99, 1)).await.unwrap();

        assert_eq!(get_instance(&pool, "a").await.unwrap().unwrap().tickets_done_total, 5);
        assert_eq!(get_instance(&pool, "b").await.unwrap().unwrap().tickets_done_total, 99);
    }
}
