//! Per-day counter of concurrent-agents cap-hit events.
//!
//! Every time a worker start is refused because the in-review cap has been
//! reached, we bump today's counter. `/api/metrics` exposes the aggregate so
//! ventas can size upgrade conversations. Queries are runtime-checked
//! (`sqlx::query`) so adding this table does not require regenerating the
//! sqlx offline cache.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

/// Row-shaped view of a single day's counter. Kept plain (no serde/ts-rs
/// derives) because it is only ever rendered into the Prometheus text
/// exposition — no JSON, no TS types.
#[derive(Debug, Clone)]
pub struct PlanCapHitDay {
    /// ISO-8601 date (UTC), e.g. "2026-08-02".
    pub date: String,
    pub count: i64,
}

pub struct PlanCapHit;

impl PlanCapHit {
    /// Today's date in UTC, as ISO-8601. Kept as a helper so callers do not
    /// each format the string.
    pub fn today_utc() -> String {
        Utc::now().format("%Y-%m-%d").to_string()
    }

    /// Increment today's counter, creating the row on first hit of the day.
    /// Best-effort by caller convention: log and continue on error rather
    /// than fail the parent operation.
    pub async fn record_hit_today(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        Self::record_hit_for_date(pool, &Self::today_utc()).await
    }

    /// Bump the counter for an explicit date. Callers use this to backfill
    /// or to record against a caller-controlled clock in tests.
    pub async fn record_hit_for_date(pool: &SqlitePool, date: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO plan_cap_hits (date, count, updated_at) \
             VALUES (?, 1, datetime('now', 'subsec')) \
             ON CONFLICT(date) DO UPDATE SET \
                count = count + 1, \
                updated_at = datetime('now', 'subsec')",
        )
        .bind(date)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Total count across all days.
    pub async fn total_count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        let row = sqlx::query("SELECT COALESCE(SUM(count), 0) AS total FROM plan_cap_hits")
            .fetch_one(pool)
            .await?;
        row.try_get::<i64, _>("total")
    }

    /// Count for today (UTC). Zero when today has no row yet.
    pub async fn count_today(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        Self::count_for_date(pool, &Self::today_utc()).await
    }

    pub async fn count_for_date(pool: &SqlitePool, date: &str) -> Result<i64, sqlx::Error> {
        let row = sqlx::query("SELECT count FROM plan_cap_hits WHERE date = ?")
            .bind(date)
            .fetch_optional(pool)
            .await?;
        Ok(row
            .map(|r| r.try_get::<i64, _>("count"))
            .transpose()?
            .unwrap_or(0))
    }

    /// All daily rows, newest first. Used by /api/metrics to emit a per-day
    /// gauge series.
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<PlanCapHitDay>, sqlx::Error> {
        let rows = sqlx::query("SELECT date, count FROM plan_cap_hits ORDER BY date DESC")
            .fetch_all(pool)
            .await?;
        rows.into_iter()
            .map(|r| {
                Ok(PlanCapHitDay {
                    date: r.try_get::<String, _>("date")?,
                    count: r.try_get::<i64, _>("count")?,
                })
            })
            .collect()
    }
}
