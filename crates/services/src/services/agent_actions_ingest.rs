//! `.vk/actions.json` — declarative agent actions inbox (AGENT-ACTIONS-SPEC.md, F1/F2).
//!
//! Same shape as `.vk/review.json`: the agent produces the file, the orchestrator
//! reads it after the agent finishes, validates strictly, and drops one outbox row
//! per declared action so [`agent_actions_drain`] can execute them against GitHub.
//!
//! F1 shipped `comment_pr` and `comment_issue`; F2 adds `create_milestone`,
//! `create_issue` and `close_issue`; `add_labels` came next, pulled forward
//! from the v2 list because the execution-label convention needs the analyst
//! to be able to tag issues it did not create. Any kind outside that catalogue
//! still fails the ingest as an invalid file so the agent finds out at test
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

/// Reference to a GitHub issue: either a literal number or a
/// `{{action[N].number}}` placeholder pointing at an earlier action of the
/// same run (typically a `create_issue`). Untagged so the wire shape stays
/// natural: `"issue": 456` and `"issue": "{{action[1].number}}"` both parse.
///
/// This exists because the analyst's primary flow REQUIRES it: the plan
/// comment goes on an issue created in the same run, whose number does not
/// exist at declaration time (incidente 10-ago: Bea's F3 épica failed ingest
/// because these fields were typed `i64`). F3 kinds (`add_labels`,
/// `update_issue`, `resolve_review_thread`) should reuse this type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum IssueRef {
    Number(i64),
    /// A placeholder (or, tolerantly, a number written as a string). The
    /// drain resolves placeholders before execution and fails the row with
    /// a legible message if the resolved value is not an integer.
    Ref(String),
}

impl std::fmt::Display for IssueRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::Ref(s) => write!(f, "{s}"),
        }
    }
}

impl IssueRef {
    /// The issue number, once placeholders were resolved. `Err` carries the
    /// raw value for the drain's legible definitive-failure message.
    pub fn as_number(&self) -> Result<i64, String> {
        match self {
            Self::Number(n) => Ok(*n),
            Self::Ref(raw) => raw.trim().parse::<i64>().map_err(|_| raw.clone()),
        }
    }
}

/// One action from `.vk/actions.json`. Serialization keeps the exact wire shape
/// the agent wrote — the JSON stored in `agent_actions.payload` is the source of
/// truth for the drain and any later surgical retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentActionDeclaration {
    CommentPr {
        pr: i64,
        body: String,
    },
    CommentIssue {
        issue: IssueRef,
        body: String,
    },
    CreateMilestone {
        title: String,
        description: String,
    },
    CreateIssue {
        title: String,
        body: String,
        #[serde(default)]
        labels: Vec<String>,
        /// May be a literal milestone number (as string) or a
        /// `{{action[N].number}}` placeholder resolved by the drain from an
        /// earlier `create_milestone`. `None` when the agent doesn't attach
        /// the issue to any milestone.
        #[serde(default)]
        milestone: Option<String>,
    },
    CloseIssue {
        issue: IssueRef,
        reason: String,
    },
    /// Tag an issue that already exists. The analyst's path for pulling a
    /// pre-existing issue (typically human-written, therefore unlabelled)
    /// into a feature/wave grouping — see
    /// `ANALYST_EXECUTION_LABELS_CONTRACT`. `issue` takes the same
    /// number-or-placeholder shape as the other issue-targeting kinds so a
    /// run can also re-tag something it created earlier in the same file.
    AddLabels {
        issue: IssueRef,
        labels: Vec<String>,
    },
}

impl AgentActionDeclaration {
    /// Discriminant string stored in the `kind` column. Matches the `tag`
    /// value serde emits so a caller can compare without deserialising.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::CommentPr { .. } => "comment_pr",
            Self::CommentIssue { .. } => "comment_issue",
            Self::CreateMilestone { .. } => "create_milestone",
            Self::CreateIssue { .. } => "create_issue",
            Self::CloseIssue { .. } => "close_issue",
            Self::AddLabels { .. } => "add_labels",
        }
    }
}

/// Envelope for `.vk/actions.json`. Actions stay as raw JSON here so each
/// element can be validated individually — a per-element failure then names
/// the offending action (index + kind) instead of a bare serde message.
#[derive(Debug, Clone, Deserialize)]
struct ActionsFile {
    #[serde(default)]
    actions: Vec<serde_json::Value>,
}

/// Cap on how much of the raw file travels into `failure_reason`. Enough to
/// diagnose without the worktree (which is archived on failure), small enough
/// to not flood the card/process view.
const RAW_EXCERPT_MAX_CHARS: usize = 1500;

/// Bounded copy of the raw file for the failure message, so an ingest failure
/// is diagnosable after the worktree is gone (incidente 10-ago: the analyst's
/// rejected `.vk/actions.json` was unrecoverable once the workspace archived).
fn raw_excerpt(raw: &str) -> String {
    if raw.chars().count() <= RAW_EXCERPT_MAX_CHARS {
        return raw.to_string();
    }
    let cut: String = raw.chars().take(RAW_EXCERPT_MAX_CHARS).collect();
    format!("{cut}\n… (truncado)")
}

/// Anything that can go wrong parsing/validating `.vk/actions.json`. Serialized
/// to the task's `failure_reason` so the human sees exactly what the agent wrote
/// (or didn't).
#[derive(Debug)]
pub enum IngestError {
    ReadError {
        path: PathBuf,
        message: String,
    },
    InvalidActions {
        reason: String,
        /// Bounded copy of what the agent actually wrote, surfaced in the
        /// failure message because the worktree (and with it the file) is
        /// archived when the task fails.
        raw_excerpt: String,
    },
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadError { path, message } => {
                write!(f, "No pude leer `{}`: {message}", path.display())
            }
            Self::InvalidActions {
                reason,
                raw_excerpt,
            } => {
                write!(
                    f,
                    "`.vk/actions.json` inválido: {reason}\n\nContenido declarado:\n{raw_excerpt}"
                )
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
            raw_excerpt: raw_excerpt(&raw),
        })?;

    // Element-wise validation: the error names the offending action by index
    // and declared kind, instead of a bare serde message that leaves the
    // human hunting through the whole file.
    let mut actions = Vec::with_capacity(file.actions.len());
    for (index, value) in file.actions.into_iter().enumerate() {
        let kind = value
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("<sin kind>")
            .to_string();
        match serde_json::from_value::<AgentActionDeclaration>(value) {
            Ok(action) => actions.push(action),
            Err(e) => {
                return Err(IngestError::InvalidActions {
                    reason: format!("acción [{index}] (`{kind}`): {e}"),
                    raw_excerpt: raw_excerpt(&raw),
                });
            }
        }
    }
    Ok(actions)
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
                assert_eq!(issue, &IssueRef::Number(456));
                assert_eq!(body, "chau");
            }
            other => panic!("expected CommentIssue, got {other:?}"),
        }
    }

    /// Regression: incidente 10-ago — the analyst's plan comment targets an
    /// issue created in the same run, so `issue` MUST accept a placeholder.
    #[test]
    fn issue_ref_fields_accept_placeholders() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(
            tmp.path(),
            r#"{"actions":[
                {"kind":"create_issue","title":"t","body":"b"},
                {"kind":"comment_issue","issue":"{{action[0].number}}","body":"plan"},
                {"kind":"close_issue","issue":"{{action[0].number}}","reason":"completed"}
            ]}"#,
        );
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert_eq!(actions.len(), 3);
        match &actions[1] {
            AgentActionDeclaration::CommentIssue { issue, .. } => {
                assert_eq!(issue, &IssueRef::Ref("{{action[0].number}}".into()));
            }
            other => panic!("expected CommentIssue, got {other:?}"),
        }
        match &actions[2] {
            AgentActionDeclaration::CloseIssue { issue, .. } => {
                assert_eq!(issue, &IssueRef::Ref("{{action[0].number}}".into()));
            }
            other => panic!("expected CloseIssue, got {other:?}"),
        }
    }

    #[test]
    fn invalid_action_error_names_index_and_kind() {
        let tmp = tempfile::tempdir().unwrap();
        // Second action is broken: comment_pr with a string pr.
        write_actions(
            tmp.path(),
            r#"{"actions":[
                {"kind":"comment_issue","issue":1,"body":"ok"},
                {"kind":"comment_pr","pr":"{{action[0].number}}","body":"x"}
            ]}"#,
        );
        let err = read_actions(tmp.path(), tmp.path()).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("acción [1]") && msg.contains("`comment_pr`"),
            "error must name the offending action: {msg}"
        );
        assert!(
            msg.contains("Contenido declarado"),
            "error must carry the raw excerpt: {msg}"
        );
    }

    #[test]
    fn issue_ref_as_number_parses_resolved_strings() {
        assert_eq!(IssueRef::Number(7).as_number(), Ok(7));
        assert_eq!(IssueRef::Ref("42".into()).as_number(), Ok(42));
        assert_eq!(IssueRef::Ref(" 42 ".into()).as_number(), Ok(42));
        assert_eq!(
            IssueRef::Ref("{{action[0].number}}".into()).as_number(),
            Err("{{action[0].number}}".to_string())
        );
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
    fn valid_create_milestone_create_issue_close_issue_parse() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(
            tmp.path(),
            r#"{"actions":[
                {"kind":"create_milestone","title":"F2","description":"agent actions"},
                {"kind":"create_issue","title":"backend","body":"do it","labels":["P1","backend"],"milestone":"{{action[0].number}}"},
                {"kind":"create_issue","title":"ui","body":"draw it","labels":[]},
                {"kind":"close_issue","issue":456,"reason":"completed"}
            ]}"#,
        );
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert_eq!(actions.len(), 4);
        match &actions[0] {
            AgentActionDeclaration::CreateMilestone { title, description } => {
                assert_eq!(title, "F2");
                assert_eq!(description, "agent actions");
            }
            other => panic!("expected CreateMilestone, got {other:?}"),
        }
        match &actions[1] {
            AgentActionDeclaration::CreateIssue {
                title,
                body,
                labels,
                milestone,
            } => {
                assert_eq!(title, "backend");
                assert_eq!(body, "do it");
                assert_eq!(labels, &vec!["P1".to_string(), "backend".to_string()]);
                assert_eq!(milestone.as_deref(), Some("{{action[0].number}}"));
            }
            other => panic!("expected CreateIssue, got {other:?}"),
        }
        match &actions[2] {
            AgentActionDeclaration::CreateIssue {
                labels, milestone, ..
            } => {
                assert!(labels.is_empty());
                assert!(milestone.is_none());
            }
            other => panic!("expected CreateIssue, got {other:?}"),
        }
        match &actions[3] {
            AgentActionDeclaration::CloseIssue { issue, reason } => {
                assert_eq!(issue, &IssueRef::Number(456));
                assert_eq!(reason, "completed");
            }
            other => panic!("expected CloseIssue, got {other:?}"),
        }
    }

    #[test]
    fn create_issue_defaults_labels_and_milestone() {
        let tmp = tempfile::tempdir().unwrap();
        // `labels` and `milestone` are optional; omitting them must not fail.
        write_actions(
            tmp.path(),
            r#"{"actions":[{"kind":"create_issue","title":"t","body":"b"}]}"#,
        );
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            AgentActionDeclaration::CreateIssue {
                labels, milestone, ..
            } => {
                assert!(labels.is_empty());
                assert!(milestone.is_none());
            }
            other => panic!("expected CreateIssue, got {other:?}"),
        }
    }

    /// `add_labels` is how the analyst pulls a pre-existing issue into a
    /// feature/wave grouping. `issue` takes both wire shapes, exactly like the
    /// other issue-targeting kinds.
    #[test]
    fn add_labels_parses_with_literal_and_placeholder_issue() {
        let tmp = tempfile::tempdir().unwrap();
        write_actions(
            tmp.path(),
            r#"{"actions":[
                {"kind":"add_labels","issue":84,"labels":["feature:rss-v1","wave:2"]},
                {"kind":"add_labels","issue":"{{action[0].number}}","labels":["resource:db-migration"]}
            ]}"#,
        );
        let actions = read_actions(tmp.path(), tmp.path()).unwrap();
        assert_eq!(actions.len(), 2);
        match &actions[0] {
            AgentActionDeclaration::AddLabels { issue, labels } => {
                assert_eq!(issue, &IssueRef::Number(84));
                assert_eq!(labels, &vec!["feature:rss-v1".to_string(), "wave:2".into()]);
            }
            other => panic!("expected AddLabels, got {other:?}"),
        }
        match &actions[1] {
            AgentActionDeclaration::AddLabels { issue, .. } => {
                assert_eq!(issue, &IssueRef::Ref("{{action[0].number}}".into()));
            }
            other => panic!("expected AddLabels, got {other:?}"),
        }
        assert_eq!(actions[0].kind_str(), "add_labels");
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
                issue: IssueRef::Number(2),
                body: "y".into()
            }
            .kind_str(),
            "comment_issue"
        );
        assert_eq!(
            AgentActionDeclaration::CreateMilestone {
                title: "t".into(),
                description: "d".into(),
            }
            .kind_str(),
            "create_milestone"
        );
        assert_eq!(
            AgentActionDeclaration::CreateIssue {
                title: "t".into(),
                body: "b".into(),
                labels: vec![],
                milestone: None,
            }
            .kind_str(),
            "create_issue"
        );
        assert_eq!(
            AgentActionDeclaration::CloseIssue {
                issue: IssueRef::Number(5),
                reason: "duplicate".into(),
            }
            .kind_str(),
            "close_issue"
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
                issue: IssueRef::Number(20),
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
