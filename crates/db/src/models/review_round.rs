use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub const KIND_REVIEW: &str = "review";
pub const KIND_REMEDIATION: &str = "remediation";

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_SUBMITTED: &str = "submitted";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_SUPERSEDED: &str = "superseded";

pub const VERDICT_APPROVE: &str = "approve";
pub const VERDICT_REQUEST_CHANGES: &str = "request_changes";

/// One review or remediation round of a PR (REVIEW-LOOP-SPEC.md).
///
/// Rounds are the idempotency ledger of the review loop: dispatch decisions
/// are lookups against this table keyed on the PR head SHA, replacing the
/// old count-based guards ("reviewer tasks done vs fix tasks dispatched")
/// that desynced whenever a task finished without its observable side
/// effect. Only `submitted` rounds count toward the per-PR round budget:
/// `failed` and `superseded` attempts are free retries.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ReviewRound {
    pub id: Uuid,
    pub repo_id: Uuid,
    pub pr_number: i64,
    /// `review` (reviewer verdict round) or `remediation` (author fix round).
    pub kind: String,
    /// PR head SHA the round was dispatched against, pinned at dispatch time.
    pub head_sha: String,
    /// Base SHA at dispatch time; recorded for conflict remediation, where
    /// the conflicting state is a property of (head, base), not head alone.
    pub base_sha: Option<String>,
    pub task_id: Option<Uuid>,
    pub status: String,
    /// `approve` | `request_changes`, set when a review round is submitted.
    pub verdict: Option<String>,
    /// GitHub review id returned on submission — the external idempotency key.
    pub review_id: Option<i64>,
    /// JSON blob describing what a remediation round addressed, e.g.
    /// `{"conflicts":true,"ci_failing":false,"changes_requested":true}`.
    pub reasons: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateReviewRound {
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub kind: String,
    pub head_sha: String,
    pub base_sha: Option<String>,
    pub task_id: Option<Uuid>,
    pub reasons: Option<String>,
}

const COLS: &str = "id, repo_id, pr_number, kind, head_sha, base_sha, task_id, \
                    status, verdict, review_id, reasons, created_at, updated_at";

impl ReviewRound {
    pub async fn create(pool: &SqlitePool, data: &CreateReviewRound) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO review_rounds
                 (id, repo_id, pr_number, kind, head_sha, base_sha, task_id, reasons)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(id)
        .bind(data.repo_id)
        .bind(data.pr_number)
        .bind(&data.kind)
        .bind(&data.head_sha)
        .bind(&data.base_sha)
        .bind(data.task_id)
        .bind(&data.reasons)
        .execute(pool)
        .await?;

        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, ReviewRound>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM review_rounds WHERE id = ?1"
        )))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_task_id(
        pool: &SqlitePool,
        task_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, ReviewRound>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM review_rounds
              WHERE task_id = ?1
              ORDER BY created_at DESC
              LIMIT 1"
        )))
        .bind(task_id)
        .fetch_optional(pool)
        .await
    }

    /// Round still in flight for the PR, any kind. The "one active round per
    /// PR" invariant is enforced by checking this before any dispatch.
    pub async fn find_pending_for_pr(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, ReviewRound>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM review_rounds
              WHERE repo_id = ?1 AND pr_number = ?2 AND status = 'pending'
              ORDER BY created_at DESC
              LIMIT 1"
        )))
        .bind(repo_id)
        .bind(pr_number)
        .fetch_optional(pool)
        .await
    }

    /// Whether a round of `kind` was already dispatched (any non-failed
    /// status) for this exact head SHA — the idempotency check that replaces
    /// the old dispatch counters. Failed rounds don't block a retry.
    pub async fn exists_for_head(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
        kind: &str,
        head_sha: &str,
    ) -> Result<bool, sqlx::Error> {
        let count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM review_rounds
              WHERE repo_id = ?1 AND pr_number = ?2 AND kind = ?3
                AND head_sha = ?4 AND status != 'failed'",
        )
        .bind(repo_id)
        .bind(pr_number)
        .bind(kind)
        .bind(head_sha)
        .fetch_one(pool)
        .await?;
        Ok(count > 0)
    }

    /// Rounds that count toward the per-PR budget (`max_review_rounds`):
    /// submitted only — failed and superseded attempts are free.
    pub async fn count_submitted_for_pr(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM review_rounds
              WHERE repo_id = ?1 AND pr_number = ?2 AND status = 'submitted'",
        )
        .bind(repo_id)
        .bind(pr_number)
        .fetch_one(pool)
        .await
    }

    /// Most recent submitted review round (kind=review) for the PR — the
    /// authoritative "last verdict" without asking GitHub.
    pub async fn latest_submitted_review(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, ReviewRound>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM review_rounds
              WHERE repo_id = ?1 AND pr_number = ?2
                AND kind = 'review' AND status = 'submitted'
              ORDER BY created_at DESC
              LIMIT 1"
        )))
        .bind(repo_id)
        .bind(pr_number)
        .fetch_optional(pool)
        .await
    }

    /// Sibling pending rounds on the exact same PR head — two reviewer
    /// workers racing on the same commit. When one submits a verdict, the
    /// others are redundant: the verdict on GitHub already covers this head
    /// SHA, so they should be superseded and their tasks cancelled. In
    /// steady state the dispatch guard prevents this from happening at all;
    /// this query is the safety net for the rare race past the guard.
    pub async fn find_other_pending_for_head(
        pool: &SqlitePool,
        repo_id: Uuid,
        pr_number: i64,
        head_sha: &str,
        exclude_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, ReviewRound>(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM review_rounds
              WHERE repo_id = ?1 AND pr_number = ?2 AND head_sha = ?3
                AND status = 'pending' AND id != ?4"
        )))
        .bind(repo_id)
        .bind(pr_number)
        .bind(head_sha)
        .bind(exclude_id)
        .fetch_all(pool)
        .await
    }

    /// Mark a review round submitted with its verdict and GitHub review id.
    pub async fn set_submitted(
        pool: &SqlitePool,
        id: Uuid,
        verdict: Option<&str>,
        review_id: Option<i64>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE review_rounds
                SET status = 'submitted', verdict = ?2, review_id = ?3,
                    updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(verdict)
        .bind(review_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_status(pool: &SqlitePool, id: Uuid, status: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE review_rounds
                SET status = ?2, updated_at = datetime('now', 'subsec')
              WHERE id = ?1",
        )
        .bind(id)
        .bind(status)
        .execute(pool)
        .await?;
        Ok(())
    }
}
