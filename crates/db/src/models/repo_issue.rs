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
    /// JSON-encoded array of label names.
    pub labels: String,
    pub author: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub synced_at: DateTime<Utc>,
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
}

impl RepoIssue {
    pub async fn list_by_repo(
        pool: &SqlitePool,
        repo_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, RepoIssue>(
            "SELECT id, repo_id, number, title, body, state, labels, author,
                    updated_at, synced_at
               FROM repo_issues
               WHERE repo_id = ?1
               ORDER BY updated_at DESC",
        )
        .bind(repo_id)
        .fetch_all(pool)
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
                 (id, repo_id, number, title, body, state, labels, author, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(repo_id, number) DO UPDATE SET
                 title      = excluded.title,
                 body       = excluded.body,
                 state      = excluded.state,
                 labels     = excluded.labels,
                 author     = excluded.author,
                 updated_at = excluded.updated_at,
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
        .execute(pool)
        .await?;
        Ok(())
    }
}
