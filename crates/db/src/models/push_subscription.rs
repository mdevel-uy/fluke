use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// One Web Push subscription — a browser's opaque endpoint on the vendor's
/// push service plus the ECDH/auth secrets needed to encrypt payloads for
/// it. Baja (deletion) happens when the sender sees 404/410 from the
/// endpoint (see `web_push` service); the frontend also upserts by
/// `endpoint` to keep rotations idempotent.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct PushSubscription {
    pub id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreatePushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
}

const COLS: &str = "id, endpoint, p256dh, auth, user_agent, created_at, updated_at";

impl PushSubscription {
    /// Upsert by `endpoint`. Re-subscribing from the same browser rotates
    /// the ECDH/auth keys, so we overwrite them and bump `updated_at` —
    /// duplicating the row would leak stale keys that decrypt to nothing.
    pub async fn upsert(
        pool: &SqlitePool,
        data: &CreatePushSubscription,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET
                 p256dh = excluded.p256dh,
                 auth = excluded.auth,
                 user_agent = excluded.user_agent,
                 updated_at = datetime('now', 'subsec')",
        )
        .bind(id)
        .bind(&data.endpoint)
        .bind(&data.p256dh)
        .bind(&data.auth)
        .bind(&data.user_agent)
        .execute(pool)
        .await?;

        sqlx::query_as::<_, PushSubscription>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM push_subscriptions WHERE endpoint = ?1"
        )))
        .bind(&data.endpoint)
        .fetch_optional(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, PushSubscription>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM push_subscriptions ORDER BY created_at ASC"
        )))
        .fetch_all(pool)
        .await
    }

    pub async fn delete_by_endpoint(pool: &SqlitePool, endpoint: &str) -> Result<u64, sqlx::Error> {
        Ok(
            sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?1")
                .bind(endpoint)
                .execute(pool)
                .await?
                .rows_affected(),
        )
    }
}
