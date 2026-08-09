//! `.vk/actions.json` — declarative agent actions inbox (AGENT-ACTIONS-SPEC.md, F1).
//!
//! Same shape as `.vk/review.json`: the agent produces the file, the orchestrator
//! reads it after the agent finishes, validates strictly, and drops one outbox row
//! per declared action so [`agent_actions_drain`] can execute them against GitHub.
//!
//! F1 supports only two kinds — `comment_pr` and `comment_issue`. Any unknown kind
//! (including reserved F2/F3 verbs like `create_issue` / `create_milestone`) fails
//! the ingest as an invalid file, per the contract, so the agent finds out at test
//! time instead of getting silent partial application.
//!
//! Missing file is a valid outcome (`Ok(vec![])`) — a run that produced no
//! declarations has nothing to drain.

use std::path::{Path, PathBuf};

use db::models::agent_action::AgentAction;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Path (relative to the worktree root) where every agent writes its declared
/// actions. Kept as a constant so prompt templates and this parser agree.
pub const ACTIONS_JSON_RELATIVE_PATH: &str = ".vk/actions.json";

/// One action from `.vk/actions.json`. Serialization keeps the exact wire shape
/// the agent wrote — the JSON stored in `agent_actions.payload` is the source of
/// truth for the drain and any later surgical retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentActionDeclaration {
    CommentPr { pr: i64, body: String },
    CommentIssue { issue: i64, body: String },
}

impl AgentActionDeclaration {
    /// Discriminant string stored in the `kind` column. Matches the `tag`
    /// value serde emits so a caller can compare without deserialising.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::CommentPr { .. } => "comment_pr",
            Self::CommentIssue { .. } => "comment_issue",
        }
    }
}

/// Envelope for `.vk/actions.json`.
#[derive(Debug, Clone, Deserialize)]
struct ActionsFile {
    #[serde(default)]
    actions: Vec<AgentActionDeclaration>,
}

/// Anything that can go wrong parsing/validating `.vk/actions.json`. Serialized
/// to the task's `failure_reason` so the human sees exactly what the agent wrote
/// (or didn't).
#[derive(Debug)]
pub enum IngestError {
    ReadError { path: PathBuf, message: String },
    InvalidActions { reason: String },
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadError { path, message } => {
                write!(f, "No pude leer `{}`: {message}", path.display())
            }
            Self::InvalidActions { reason } => {
                write!(f, "`.vk/actions.json` inválido: {reason}")
            }
        }
    }
}

impl std::error::Error for IngestError {}

/// Read `.vk/actions.json`, preferring the repo worktree and falling back to the
/// workspace root — mirrors [`review_verdict::read_and_validate_with_fallback`],
/// same reason: the agent's cwd starts one level above the repo, and a file
/// written relative to that cwd (without `cd`ing in) must not be lost.
///
/// Missing at both paths is a valid empty result — a run without declared
/// effects is a legitimate no-op, not an error.
pub fn read_actions(
    worktree_primary: &Path,
    worktree_fallback: &Path,
) -> Result<Vec<AgentActionDeclaration>, IngestError> {
    let primary_path = worktree_primary.join(ACTIONS_JSON_RELATIVE_PATH);
    if primary_path.exists() {
        return parse_actions_file(&primary_path);
    }
    if worktree_fallback != worktree_primary {
        let fallback_path = worktree_fallback.join(ACTIONS_JSON_RELATIVE_PATH);
        if fallback_path.exists() {
            return parse_actions_file(&fallback_path);
        }
    }
    Ok(Vec::new())
}

fn parse_actions_file(path: &Path) -> Result<Vec<AgentActionDeclaration>, IngestError> {
    let raw = std::fs::read_to_string(path).map_err(|e| IngestError::ReadError {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let file: ActionsFile =
        serde_json::from_str(&raw).map_err(|e| IngestError::InvalidActions {
            reason: e.to_string(),
        })?;
    Ok(file.actions)
}

/// Persist every declared action as a `pending` outbox row in one transaction.
///
/// `INSERT OR IGNORE` on `UNIQUE(task_id, seq)` gives structural idempotency:
/// re-ingesting the same run is a no-op, pending rows survive, and the drain
/// can be safely re-driven. On any DB error the transaction rolls back so
/// nothing partial reaches the outbox — the caller marks the task failed.
///
/// Returns every outbox row currently associated with the task (including
/// pre-existing rows on a re-ingest), ordered by `seq`.
pub async fn insert_all(
    pool: &SqlitePool,
    task_id: Uuid,
    repo_id: Uuid,
    actions: &[AgentActionDeclaration],
) -> Result<Vec<AgentAction>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    for (index, action) in actions.iter().enumerate() {
        let id = Uuid::new_v4();
        let seq = index as i64;
        let kind = action.kind_str();
        let payload = serde_json::to_string(action).expect("action serialises");
        sqlx::query(
            "INSERT OR IGNORE INTO agent_actions
                 (id, task_id, repo_id, seq, kind, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(id)
        .bind(task_id)
        .bind(repo_id)
        .bind(seq)
        .bind(kind)
        .bind(payload)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    AgentAction::find_by_task_id(pool, task_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_actions(dir: &Path, contents: &str) {
        std::fs::create_dir_all(dir.join(".vk")).unwrap();
        std::fs::write(dir.join(ACTIONS_JSON_RELATIVE_PATH), contents).unwrap();
    }

    #[test]
    fn valid_comment_pr_and_comment_issue_parse() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(
            tmp.path(),
            r#"{"actions":[
                {"kind":"comment_pr","pr":123,"body":"hola"},
                {"kind":"comment_issue","issue":456,"body":"chau"}
            ]}"#,
        );
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert_eq!(actions.len(), 2);
        match &actions[0] {
            AgentActionDeclaration::CommentPr { pr, body } => {
                assert_eq!(*pr, 123);
                assert_eq!(body, "hola");
            }
            other => panic!("expected CommentPr, got {other:?}"),
        }
        match &actions[1] {
            AgentActionDeclaration::CommentIssue { issue, body } => {
                assert_eq!(*issue, 456);
                assert_eq!(body, "chau");
            }
            other => panic!("expected CommentIssue, got {other:?}"),
        }
    }

    #[test]
    fn empty_array_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(tmp.path(), r#"{"actions":[]}"#);
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert!(actions.is_empty());
    }

    #[test]
    fn missing_file_in_both_paths_is_ok() {
        let primary = tempfile::tempdir().unwrap();
        let fallback = tempfile::tempdir().unwrap();
        let actions = read_actions(primary.path(), fallback.path()).unwrap();
        assert!(actions.is_empty());
    }

    #[test]
    fn falls_back_to_workspace_root() {
        let workspace = tempfile::tempdir().unwrap();
        let repo = workspace.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_actions(
            workspace.path(),
            r#"{"actions":[{"kind":"comment_pr","pr":9,"body":"x"}]}"#,
        );
        let actions = read_actions(&repo, workspace.path()).unwrap();
        assert_eq!(actions.len(), 1);
    }

    #[test]
    fn unknown_kind_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        // F2/F3 verbs are still unknown in F1 and must be rejected as invalid.
        write_actions(
            tmp.path(),
            r#"{"actions":[{"kind":"create_issue","title":"x","body":"y"}]}"#,
        );
        let err = read_actions(tmp.path(), tmp.path()).unwrap_err();
        assert!(matches!(err, IngestError::InvalidActions { .. }));
    }

    #[test]
    fn totally_unknown_kind_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(
            tmp.path(),
            r#"{"actions":[{"kind":"launch_missiles","target":"foo"}]}"#,
        );
        let err = read_actions(tmp.path(), tmp.path()).unwrap_err();
        assert!(matches!(err, IngestError::InvalidActions { .. }));
    }

    #[test]
    fn malformed_json_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(tmp.path(), "{not-json");
        let err = read_actions(tmp.path(), tmp.path()).unwrap_err();
        assert!(matches!(err, IngestError::InvalidActions { .. }));
    }

    #[test]
    fn missing_required_field_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        // comment_pr requires `pr` and `body`; missing `body` must fail.
        write_actions(tmp.path(), r#"{"actions":[{"kind":"comment_pr","pr":1}]}"#);
        let err = read_actions(tmp.path(), tmp.path()).unwrap_err();
        assert!(matches!(err, IngestError::InvalidActions { .. }));
    }

    #[test]
    fn kind_str_matches_serde_tag() {
        assert_eq!(
            AgentActionDeclaration::CommentPr {
                pr: 1,
                body: "x".into()
            }
            .kind_str(),
            "comment_pr"
        );
        assert_eq!(
            AgentActionDeclaration::CommentIssue {
                issue: 2,
                body: "y".into()
            }
            .kind_str(),
            "comment_issue"
        );
    }

    // ---------------- DB tests -----------------

    /// FKs off after migrating so the tests only need the rows they actually
    /// exercise (matches the `usage.rs` pattern).
    async fn test_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn seed_repo_and_task(pool: &SqlitePool) -> (Uuid, Uuid) {
        let repo_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name, parallel_setup_script)
             VALUES (?1, ?2, ?3, ?3, 0)",
        )
        .bind(repo_id)
        .bind(format!("/tmp/repo-{repo_id}"))
        .bind("test-repo")
        .execute(pool)
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        let worker_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, status)
             VALUES (?1, ?2, ?3, 0, 't', 'p', 'queued')",
        )
        .bind(task_id)
        .bind(worker_id)
        .bind(repo_id)
        .execute(pool)
        .await
        .unwrap();

        (repo_id, task_id)
    }

    #[tokio::test]
    async fn insert_all_persists_rows_with_sequential_seq() {
        let pool = test_pool().await;
        let (repo_id, task_id) = seed_repo_and_task(&pool).await;

        let actions = vec![
            AgentActionDeclaration::CommentPr {
                pr: 10,
                body: "a".into(),
            },
            AgentActionDeclaration::CommentIssue {
                issue: 20,
                body: "b".into(),
            },
        ];
        let rows = insert_all(&pool, task_id, repo_id, &actions).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].seq, 0);
        assert_eq!(rows[0].kind, "comment_pr");
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[1].seq, 1);
        assert_eq!(rows[1].kind, "comment_issue");
    }

    #[tokio::test]
    async fn insert_all_is_idempotent_on_reingest() {
        let pool = test_pool().await;
        let (repo_id, task_id) = seed_repo_and_task(&pool).await;

        let actions = vec![AgentActionDeclaration::CommentPr {
            pr: 42,
            body: "hi".into(),
        }];
        let first = insert_all(&pool, task_id, repo_id, &actions).await.unwrap();
        assert_eq!(first.len(), 1);
        let first_id = first[0].id;

        let second = insert_all(&pool, task_id, repo_id, &actions).await.unwrap();
        assert_eq!(second.len(), 1);
        // INSERT OR IGNORE preserves the original row (same id, same status).
        assert_eq!(second[0].id, first_id);
        assert_eq!(second[0].status, "pending");
    }

    #[tokio::test]
    async fn insert_all_with_empty_actions_is_noop() {
        let pool = test_pool().await;
        let (repo_id, task_id) = seed_repo_and_task(&pool).await;

        let rows = insert_all(&pool, task_id, repo_id, &[]).await.unwrap();
        assert!(rows.is_empty());
    }
}
