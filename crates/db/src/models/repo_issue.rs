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
}

impl RepoIssue {
    pub async fn list_by_repo(
        pool: &SqlitePool,
        repo_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, RepoIssue>(
            "SELECT id, repo_id, number, title, body, state, labels, author,
                    updated_at, synced_at, milestone
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
                    updated_at, synced_at, milestone
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
                 (id, repo_id, number, title, body, state, labels, author, updated_at, milestone)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(repo_id, number) DO UPDATE SET
                 title      = excluded.title,
                 body       = excluded.body,
                 state      = excluded.state,
                 labels     = excluded.labels,
                 author     = excluded.author,
                 updated_at = excluded.updated_at,
                 milestone  = excluded.milestone,
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
}
