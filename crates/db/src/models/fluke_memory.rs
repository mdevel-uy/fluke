//! Fluke's memory, embedded (J3): what Fluke learned about the user across
//! conversations. Fluke writes it itself (`remember` / `forget` tools) and
//! each turn gets the memories that matter for the user's message, found
//! with SQLite FTS5. No external service, no extra key.

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};

pub const KINDS: [&str; 3] = ["preference", "decision", "fact"];

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct FlukeMemory {
    pub id: i64,
    pub fact: String,
    pub kind: String,
    pub created_at: String,
    pub uses: i64,
}

const COLUMNS: &str = "m.id, m.fact, m.kind, m.created_at, m.uses";

impl FlukeMemory {
    /// Save a memory; the same fact (ignoring case) is not saved twice.
    pub async fn remember(pool: &SqlitePool, fact: &str, kind: &str) -> Result<i64, sqlx::Error> {
        let fact = fact.trim();
        if let Some(id) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM fluke_memories WHERE lower(fact) = lower(?1) LIMIT 1",
        )
        .bind(fact)
        .fetch_optional(pool)
        .await?
        {
            return Ok(id);
        }
        sqlx::query_scalar("INSERT INTO fluke_memories (fact, kind) VALUES (?1, ?2) RETURNING id")
            .bind(fact)
            .bind(kind)
            .fetch_one(pool)
            .await
    }

    pub async fn forget(pool: &SqlitePool, id: i64) -> Result<bool, sqlx::Error> {
        Ok(sqlx::query("DELETE FROM fluke_memories WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected()
            > 0)
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM fluke_memories m ORDER BY m.id"
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM fluke_memories")
            .fetch_one(pool)
            .await
    }

    /// The memories that match `query` best (FTS5 rank), up to `limit`.
    pub async fn relevant(
        pool: &SqlitePool,
        query: &str,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let Some(expr) = fts_query(query) else {
            return Ok(Vec::new());
        };
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM fluke_memories_fts f \
               JOIN fluke_memories m ON m.id = f.rowid \
              WHERE fluke_memories_fts MATCH ?1 ORDER BY f.rank LIMIT ?2"
        ))
        .bind(expr)
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// The most used memories, the ones that keep mattering.
    pub async fn most_used(pool: &SqlitePool, limit: i64) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {COLUMNS} FROM fluke_memories m \
              ORDER BY m.uses DESC, m.id DESC LIMIT ?1"
        ))
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// These memories went into a turn.
    pub async fn mark_used(pool: &SqlitePool, ids: &[i64]) -> Result<(), sqlx::Error> {
        for id in ids {
            sqlx::query(
                "UPDATE fluke_memories SET uses = uses + 1, \
                        last_used_at = datetime('now', 'subsec') WHERE id = ?1",
            )
            .bind(id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }
}

/// An FTS5 expression from free text: its words (3+ chars) as quoted prefix
/// terms joined with OR, so punctuation or FTS syntax in the message cannot
/// break the query. FTS5 does not stem: a long word loses a final "s" and
/// matches as a prefix, so "login" finds "logins" and the other way round.
/// `None` when there is nothing to search.
fn fts_query(text: &str) -> Option<String> {
    let mut terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(|w| {
            let w = w.to_lowercase();
            let w = match w.strip_suffix('s') {
                Some(stem) if stem.chars().count() >= 4 => stem.to_string(),
                _ => w,
            };
            format!("\"{w}\"*")
        })
        .collect();
    terms.sort();
    terms.dedup();
    terms.truncate(32);
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_query_is_safe() {
        assert_eq!(fts_query("¿y el \"logins\" OR*?"), Some("\"login\"*".into()));
        assert_eq!(fts_query("a b"), None);
    }

    #[tokio::test]
    async fn remember_find_and_forget() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let device = FlukeMemory::remember(&pool, "Prefiere device flow para los logins", "preference")
            .await
            .unwrap();
        // Same fact again: not duplicated.
        assert_eq!(
            FlukeMemory::remember(&pool, "prefiere DEVICE flow para los logins", "preference")
                .await
                .unwrap(),
            device
        );
        let review = FlukeMemory::remember(&pool, "Los PRs de UI los revisa él", "decision")
            .await
            .unwrap();
        assert_eq!(FlukeMemory::count(&pool).await.unwrap(), 2);

        // Accents and case do not matter.
        let hits = FlukeMemory::relevant(&pool, "armemos el LOGIN de escritorio", 5)
            .await
            .unwrap();
        assert_eq!(hits.iter().map(|m| m.id).collect::<Vec<_>>(), vec![device]);
        // Short common words also match, lower: the best match comes first.
        let hits = FlukeMemory::relevant(&pool, "¿quién revisá los prs?", 5).await.unwrap();
        assert_eq!(hits.first().map(|m| m.id), Some(review));

        FlukeMemory::mark_used(&pool, &[review]).await.unwrap();
        assert_eq!(FlukeMemory::most_used(&pool, 1).await.unwrap()[0].id, review);

        assert!(FlukeMemory::forget(&pool, device).await.unwrap());
        assert!(FlukeMemory::relevant(&pool, "login", 5).await.unwrap().is_empty());
        assert!(!FlukeMemory::forget(&pool, device).await.unwrap());
    }
}
