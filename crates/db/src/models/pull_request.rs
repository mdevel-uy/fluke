use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::merge::{Merge, MergeStatus, PrMerge, PullRequestInfo};

#[derive(Debug, Clone, FromRow)]
pub struct PullRequest {
    pub id: String,
    /// Legacy "first owner" workspace. Kept for remote sync
    /// (`local_workspace_id`); workspace-scoped lookups go through the
    /// `workspace_pull_requests` N:M link table instead.
    pub workspace_id: Option<Uuid>,
    pub repo_id: Option<Uuid>,
    pub pr_url: String,
    pub pr_number: i64,
    pub pr_status: MergeStatus,
    pub target_branch_name: String,
    pub merged_at: Option<DateTime<Utc>>,
    pub merge_commit_sha: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub synced_at: Option<DateTime<Utc>>,
    /// GitHub mergeable state: "mergeable", "conflicting", "unknown", or None if not yet polled.
    pub pr_mergeable: Option<String>,
}

/// Row shape for link-table queries that need both the linked workspace and
/// the PR itself (`get_latest_for_workspaces`).
#[derive(FromRow)]
struct LinkedPullRequest {
    link_workspace_id: Uuid,
    #[sqlx(flatten)]
    pr: PullRequest,
}

/// Column list for runtime (non-macro) SELECTs, prefixed with `p.`.
/// `pr_ci_status` is intentionally excluded (see `update_ci_status`).
const PR_COLUMNS: &str = "p.id, p.workspace_id, p.repo_id, p.pr_url, p.pr_number, p.pr_status, \
     p.target_branch_name, p.merged_at, p.merge_commit_sha, p.created_at, p.updated_at, \
     p.synced_at, p.pr_mergeable";

impl PullRequest {
    pub async fn create(
        pool: &SqlitePool,
        workspace_id: Option<Uuid>,
        repo_id: Option<Uuid>,
        pr_url: &str,
        pr_number: i64,
        target_branch_name: &str,
    ) -> Result<PullRequest, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        sqlx::query!(
            "INSERT INTO pull_requests (id, workspace_id, repo_id, pr_url, pr_number, pr_status, target_branch_name, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(pr_url) DO UPDATE SET
                workspace_id = COALESCE(pull_requests.workspace_id, excluded.workspace_id),
                repo_id = COALESCE(pull_requests.repo_id, excluded.repo_id),
                pr_mergeable = NULL,
                updated_at = CURRENT_TIMESTAMP",
            id,
            workspace_id,
            repo_id,
            pr_url,
            pr_number,
            target_branch_name,
            now,
        )
        .execute(pool)
        .await?;

        let pr = Self::find_by_url(pool, pr_url)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        // N:M: every workspace that (re-)records this PR keeps a link to it,
        // regardless of which workspace the legacy owner column points at.
        if let Some(workspace_id) = workspace_id {
            Self::link_workspace(pool, workspace_id, &pr.id).await?;
        }
        Ok(pr)
    }

    /// Link a workspace to a PR record (idempotent). This is what makes the
    /// PR visible from that workspace: `find_by_workspace_id` and friends
    /// resolve through the `workspace_pull_requests` table.
    pub async fn link_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
        pull_request_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT OR IGNORE INTO workspace_pull_requests (workspace_id, pull_request_id)
             VALUES (?, ?)",
        )
        .bind(workspace_id)
        .bind(pull_request_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Newest PR record for (repo, number), if any. Runtime query so the
    /// sqlx offline metadata stays valid.
    pub async fn find_by_repo_and_number(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
    ) -> Result<Option<PullRequest>, sqlx::Error> {
        sqlx::query_as::<_, PullRequest>(&format!(
            "SELECT {PR_COLUMNS} FROM pull_requests p
              WHERE p.repo_id = ? AND p.pr_number = ?
              ORDER BY p.created_at DESC LIMIT 1"
        ))
        .bind(repo_id)
        .bind(pr_number)
        .fetch_optional(pool)
        .await
    }

    pub async fn create_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
        target_branch_name: &str,
        pr_number: i64,
        pr_url: &str,
    ) -> Result<PullRequest, sqlx::Error> {
        Self::create(
            pool,
            Some(workspace_id),
            Some(repo_id),
            pr_url,
            pr_number,
            target_branch_name,
        )
        .await
    }

    pub async fn get_open(pool: &SqlitePool) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>",
                pr_mergeable
            FROM pull_requests
            WHERE pr_status = 'open'"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn update_mergeable(
        pool: &SqlitePool,
        pr_url: &str,
        mergeable: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE pull_requests SET pr_mergeable = ?, updated_at = ? WHERE pr_url = ?",
            mergeable,
            now,
            pr_url,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Persist the CI rollup state ("passing" | "failing" | "pending" |
    /// "none" | "unknown") of a PR.
    ///
    /// `pr_ci_status` is intentionally kept out of the `PullRequest` struct
    /// and queried at runtime: the `query_as!` macros above don't select it,
    /// so the committed sqlx offline metadata stays valid. Deliberately does
    /// not bump `updated_at` — CI state changes must not re-trigger the
    /// remote sync sweep.
    pub async fn update_ci_status(
        pool: &SqlitePool,
        pr_url: &str,
        ci_status: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE pull_requests SET pr_ci_status = ? WHERE pr_url = ?")
            .bind(ci_status)
            .bind(pr_url)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Workspace most recently linked to the PR (repo, number), if any.
    /// Runtime query (no macro) so the sqlx offline metadata stays valid.
    pub async fn find_latest_workspace_for_pr(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let row: Option<(Uuid,)> = sqlx::query_as(
            "SELECT l.workspace_id
               FROM workspace_pull_requests l
               JOIN pull_requests p ON p.id = l.pull_request_id
              WHERE p.repo_id = ? AND p.pr_number = ?
              ORDER BY l.created_at DESC LIMIT 1",
        )
        .bind(repo_id)
        .bind(pr_number)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|r| r.0))
    }

    /// CI rollup state per PR URL, for every PR that has one recorded.
    pub async fn get_ci_status_by_url(
        pool: &SqlitePool,
    ) -> Result<HashMap<String, String>, sqlx::Error> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT pr_url, pr_ci_status FROM pull_requests WHERE pr_ci_status IS NOT NULL",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }

    pub async fn update_status(
        pool: &SqlitePool,
        pr_url: &str,
        status: &MergeStatus,
        merged_at: Option<DateTime<Utc>>,
        merge_commit_sha: Option<String>,
    ) -> Result<(), sqlx::Error> {
        let status_str = match status {
            MergeStatus::Open => "open",
            MergeStatus::Merged => "merged",
            MergeStatus::Closed => "closed",
            MergeStatus::Unknown => "unknown",
        };
        let now = Utc::now();
        sqlx::query!(
            "UPDATE pull_requests SET pr_status = ?, merged_at = ?, merge_commit_sha = ?, updated_at = ?, synced_at = NULL WHERE pr_url = ?",
            status_str,
            merged_at,
            merge_commit_sha,
            now,
            pr_url,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_url(
        pool: &SqlitePool,
        pr_url: &str,
    ) -> Result<Option<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>",
                pr_mergeable
            FROM pull_requests
            WHERE pr_url = $1"#,
            pr_url,
        )
        .fetch_optional(pool)
        .await
    }

    /// PRs linked to a workspace (via `workspace_pull_requests`), newest
    /// first. Runtime query so the sqlx offline metadata stays valid.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as::<_, PullRequest>(&format!(
            "SELECT {PR_COLUMNS}
               FROM pull_requests p
               JOIN workspace_pull_requests l ON l.pull_request_id = p.id
              WHERE l.workspace_id = ?
              ORDER BY p.created_at DESC"
        ))
        .bind(workspace_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_workspace_and_repo_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
        repo_id: Uuid,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as::<_, PullRequest>(&format!(
            "SELECT {PR_COLUMNS}
               FROM pull_requests p
               JOIN workspace_pull_requests l ON l.pull_request_id = p.id
              WHERE l.workspace_id = ? AND p.repo_id = ?
              ORDER BY p.created_at DESC"
        ))
        .bind(workspace_id)
        .bind(repo_id)
        .fetch_all(pool)
        .await
    }

    pub async fn count_open_for_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(1)
               FROM pull_requests p
               JOIN workspace_pull_requests l ON l.pull_request_id = p.id
              WHERE l.workspace_id = ? AND p.pr_status = 'open'",
        )
        .bind(workspace_id)
        .fetch_one(pool)
        .await?;
        Ok(row.0)
    }

    /// Latest linked PR per workspace. Rows come back oldest-first and later
    /// entries overwrite earlier ones in the map, which yields the newest PR
    /// for each workspace without a GROUP BY.
    pub async fn get_latest_for_workspaces(
        pool: &SqlitePool,
        archived: bool,
    ) -> Result<HashMap<Uuid, PullRequest>, sqlx::Error> {
        let rows = sqlx::query_as::<_, LinkedPullRequest>(&format!(
            "SELECT l.workspace_id AS link_workspace_id, {PR_COLUMNS}
               FROM pull_requests p
               JOIN workspace_pull_requests l ON l.pull_request_id = p.id
               JOIN workspaces w ON w.id = l.workspace_id
              WHERE w.archived = ?
              ORDER BY p.created_at ASC"
        ))
        .bind(archived)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| (row.link_workspace_id, row.pr))
            .collect())
    }

    pub async fn find_all_with_workspace(
        pool: &SqlitePool,
    ) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>",
                pr_mergeable
            FROM pull_requests
            WHERE workspace_id IS NOT NULL
            ORDER BY created_at ASC"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn get_pending_sync(pool: &SqlitePool) -> Result<Vec<PullRequest>, sqlx::Error> {
        sqlx::query_as!(
            PullRequest,
            r#"SELECT
                id,
                workspace_id AS "workspace_id: Uuid",
                repo_id AS "repo_id: Uuid",
                pr_url,
                pr_number,
                pr_status AS "pr_status: MergeStatus",
                target_branch_name,
                merged_at AS "merged_at: DateTime<Utc>",
                merge_commit_sha,
                created_at AS "created_at!: DateTime<Utc>",
                updated_at AS "updated_at!: DateTime<Utc>",
                synced_at AS "synced_at: DateTime<Utc>",
                pr_mergeable
            FROM pull_requests
            WHERE synced_at IS NULL OR synced_at < updated_at"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn mark_synced(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE pull_requests SET synced_at = ? WHERE id = ?",
            now,
            id,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub fn to_pr_merge(&self) -> PrMerge {
        PrMerge {
            id: Uuid::parse_str(&self.id).unwrap_or_else(|_| Uuid::nil()),
            workspace_id: self.workspace_id.unwrap_or_else(Uuid::nil),
            repo_id: self.repo_id.unwrap_or_else(Uuid::nil),
            created_at: self.created_at,
            target_branch_name: self.target_branch_name.clone(),
            pr_info: PullRequestInfo {
                number: self.pr_number,
                url: self.pr_url.clone(),
                status: self.pr_status.clone(),
                merged_at: self.merged_at,
                merge_commit_sha: self.merge_commit_sha.clone(),
                mergeable: self.pr_mergeable.clone(),
            },
        }
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        // No FK cascade on the link table — clean it up explicitly.
        sqlx::query("DELETE FROM workspace_pull_requests WHERE pull_request_id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        sqlx::query!("DELETE FROM pull_requests WHERE id = ?", id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub fn to_merge(&self) -> Merge {
        Merge::Pr(self.to_pr_merge())
    }
}
