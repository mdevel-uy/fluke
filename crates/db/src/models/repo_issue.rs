use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct RepoIssue {
    pub id: Uuid,
    pub repo_id: Uuid,
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    /// JSON-encoded array of label objects: [{name, color}].
    pub labels: String,
    pub author: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub synced_at: DateTime<Utc>,
    pub milestone: Option<String>,
    /// When GitHub closed the issue. `None` for open issues, and also for
    /// closed issues that have not been re-synced since the column was added.
    pub closed_at: Option<DateTime<Utc>>,
}

/// Render a timestamp the way SQLite's `datetime('now', 'subsec')` does, so
/// values written from Rust and values written by SQL share one comparable
/// textual format.
fn format_sqlite_datetime(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

#[derive(Debug, Clone)]
pub struct UpsertRepoIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub labels: String,
    pub author: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub milestone: Option<String>,
    pub closed_at: Option<DateTime<Utc>>,
}

impl RepoIssue {
    pub async fn list_by_repo(pool: &SqlitePool, repo_id: Uuid) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, RepoIssue>(
            "SELECT id, repo_id, number, title, body, state, labels, author,
                    updated_at, synced_at, milestone, closed_at
               FROM repo_issues
               WHERE repo_id = ?1
               ORDER BY updated_at DESC",
        )
        .bind(repo_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_repo_and_number(
        pool: &SqlitePool,
        repo_id: Uuid,
        number: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, RepoIssue>(
            "SELECT id, repo_id, number, title, body, state, labels, author,
                    updated_at, synced_at, milestone, closed_at
               FROM repo_issues
               WHERE repo_id = ?1 AND number = ?2",
        )
        .bind(repo_id)
        .bind(number)
        .fetch_optional(pool)
        .await
    }

    pub async fn upsert(
        pool: &SqlitePool,
        repo_id: Uuid,
        issue: &UpsertRepoIssue,
    ) -> Result<(), sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repo_issues
                 (id, repo_id, number, title, body, state, labels, author, updated_at, milestone,
                  closed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(repo_id, number) DO UPDATE SET
                 title      = excluded.title,
                 body       = excluded.body,
                 state      = excluded.state,
                 labels     = excluded.labels,
                 author     = excluded.author,
                 updated_at = excluded.updated_at,
                 milestone  = excluded.milestone,
                 closed_at  = excluded.closed_at,
                 synced_at  = datetime('now', 'subsec')",
        )
        .bind(id)
        .bind(repo_id)
        .bind(issue.number)
        .bind(&issue.title)
        .bind(&issue.body)
        .bind(&issue.state)
        .bind(&issue.labels)
        .bind(&issue.author)
        .bind(issue.updated_at)
        .bind(&issue.milestone)
        // Stored in SQLite's own datetime shape ("YYYY-MM-DD HH:MM:SS.SSS"),
        // matching what `datetime('now', 'subsec')` writes for `synced_at`, so
        // that string comparisons against `datetime(...)` bounds order correctly.
        .bind(issue.closed_at.map(format_sqlite_datetime))
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update only the labels JSON for a specific issue (used by the priority endpoint).
    pub async fn update_labels(
        pool: &SqlitePool,
        repo_id: Uuid,
        number: i64,
        labels_json: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE repo_issues
                SET labels = ?1, synced_at = datetime('now', 'subsec')
              WHERE repo_id = ?2 AND number = ?3",
        )
        .bind(labels_json)
        .bind(repo_id)
        .bind(number)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update only the state for a specific issue (used by the close endpoint).
    ///
    /// Also stamps `closed_at` so a locally closed issue shows up in the impact
    /// chart immediately instead of waiting for the next GitHub sync. An
    /// existing timestamp is preserved (`COALESCE`) so re-closing never moves
    /// the original close date; reopening clears it, matching GitHub.
    pub async fn update_state(
        pool: &SqlitePool,
        repo_id: Uuid,
        number: i64,
        state: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE repo_issues
                SET state = ?1,
                    closed_at = CASE
                        WHEN ?1 = 'closed'
                        THEN COALESCE(closed_at, datetime('now', 'subsec'))
                        ELSE NULL
                    END,
                    synced_at = datetime('now', 'subsec')
              WHERE repo_id = ?2 AND number = ?3",
        )
        .bind(state)
        .bind(repo_id)
        .bind(number)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Delete all issues for `repo_id` whose number is not in `keep_numbers`.
    /// Call this after a successful sync to prune stale rows.
    pub async fn delete_not_in(
        pool: &SqlitePool,
        repo_id: Uuid,
        keep_numbers: &[i64],
    ) -> Result<u64, sqlx::Error> {
        if keep_numbers.is_empty() {
            let result = sqlx::query("DELETE FROM repo_issues WHERE repo_id = ?1")
                .bind(repo_id)
                .execute(pool)
                .await?;
            return Ok(result.rows_affected());
        }

        // Build "?2, ?3, ..." positional placeholders for the NOT IN list.
        let placeholders: String = (2..=keep_numbers.len() + 1)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");

        let sql = format!(
            "DELETE FROM repo_issues WHERE repo_id = ?1 AND number NOT IN ({placeholders})"
        );

        let mut q = sqlx::query(&sql).bind(repo_id);
        for n in keep_numbers {
            q = q.bind(*n);
        }
        q.execute(pool).await.map(|r| r.rows_affected())
    }
}
