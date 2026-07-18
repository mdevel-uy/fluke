use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ProjectIssue {
    pub id: Uuid,
    pub project_id: Uuid,
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
pub struct UpsertProjectIssue {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub labels: String,
    pub author: Option<String>,
    pub updated_at: DateTime<Utc>,
}

impl ProjectIssue {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, ProjectIssue>(
            "SELECT id, project_id, number, title, body, state, labels, author,
                    updated_at, synced_at
               FROM project_issues
               WHERE project_id = ?1
               ORDER BY updated_at DESC",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    pub async fn upsert(
        pool: &SqlitePool,
        project_id: Uuid,
        issue: &UpsertProjectIssue,
    ) -> Result<(), sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_issues
                 (id, project_id, number, title, body, state, labels, author, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(project_id, number) DO UPDATE SET
                 title      = excluded.title,
                 body       = excluded.body,
                 state      = excluded.state,
                 labels     = excluded.labels,
                 author     = excluded.author,
                 updated_at = excluded.updated_at,
                 synced_at  = datetime('now', 'subsec')",
        )
        .bind(id)
        .bind(project_id)
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
