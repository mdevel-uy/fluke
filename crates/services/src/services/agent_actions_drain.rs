//! Drain the `agent_actions` outbox for a task against GitHub
//! (AGENT-ACTIONS-SPEC.md, F1).
//!
//! The ingest step [`agent_actions_ingest`] persists one row per declared
//! action; this module actually **runs** them, in strict `seq` order, using
//! server-side identity (the worker's PAT when configured; otherwise the
//! machine's `gh auth` credentials). Success flips the row to `done`; a
//! definitive failure flips it to `failed` and **halts** the drain — the
//! remaining rows stay `pending` so the surgical retry endpoint (next issue in
//! the series) can re-drive them without re-running the agent.
//!
//! F1 supports `comment_pr` and `comment_issue`; both are best-effort side
//! effects on GitHub, not authoritative writes. Infra hiccups (rate limits,
//! 5xx, transient network) are retried inline with a short exponential backoff
//! before we give up and leave the row `pending`; definitive HTTP failures
//! (404, 422, permissions) short-circuit the drain immediately.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use db::models::{
    agent_action::{self, AgentAction},
    repo::Repo,
    worker::Worker,
    worker_task::WorkerTask,
};
use sqlx::SqlitePool;
use tokio::{process::Command, sync::RwLock};
use tracing::{info, warn};
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path};
use uuid::Uuid;

use crate::services::{agent_actions_ingest::AgentActionDeclaration, config::Config};

/// Roll-up of what a drain call did. `pending_remaining > 0` with
/// `failed == 0` means an infra hiccup halted us — the surgical retry endpoint
/// can pick them up later without re-running the agent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DrainResult {
    pub done: usize,
    pub failed: usize,
    pub pending_remaining: usize,
}

#[derive(Debug)]
pub enum DrainError {
    Db(sqlx::Error),
    TaskNotFound(Uuid),
    RepoNotFound(Uuid),
    /// A row on disk had a payload we could not deserialise against the
    /// current `AgentActionDeclaration` shape (e.g. schema drift). Definitive
    /// by nature — no amount of retry fixes it.
    InvalidPayload {
        action_id: Uuid,
        seq: i64,
        message: String,
    },
    /// Could not derive `owner/repo` from the repo's origin remote — the
    /// drain has nothing to point `gh` at.
    RepoRemoteResolution {
        repo_id: Uuid,
        message: String,
    },
}

impl std::fmt::Display for DrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "DB error: {e}"),
            Self::TaskNotFound(id) => write!(f, "Task not found: {id}"),
            Self::RepoNotFound(id) => write!(f, "Repo not found: {id}"),
            Self::InvalidPayload {
                action_id,
                seq,
                message,
            } => write!(
                f,
                "Invalid payload for action {action_id} (seq={seq}): {message}"
            ),
            Self::RepoRemoteResolution { repo_id, message } => write!(
                f,
                "Could not resolve GitHub owner/repo for repo {repo_id}: {message}"
            ),
        }
    }
}

impl std::error::Error for DrainError {}

impl From<sqlx::Error> for DrainError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// Why a single action's execution failed. Drives the drain-loop policy:
/// `Infra` gets short in-process retries; `Definitive` halts the drain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureKind {
    Infra,
    Definitive,
}

/// Outcome of one successful action execution, ready to be persisted with
/// [`AgentAction::set_done`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutedAction {
    pub result_number: Option<i64>,
    pub result_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutorFailure {
    pub kind: FailureKind,
    pub message: String,
}

/// Backend that actually turns a declared action into a GitHub side effect.
/// Extracted as a trait so the drain loop can be unit-tested without shelling
/// out to `gh`.
#[async_trait]
pub trait ActionExecutor: Send + Sync {
    async fn post_pr_comment(
        &self,
        owner_repo: &str,
        pr_number: i64,
        body: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure>;

    async fn post_issue_comment(
        &self,
        owner_repo: &str,
        issue_number: i64,
        body: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure>;
}

/// Max attempts (initial + retries) per action within one drain call. Infra
/// failures burn attempts up to this cap; then the drain halts leaving the
/// row `pending`.
const MAX_ATTEMPTS_PER_DRAIN: usize = 3;

/// Backoff schedule between in-drain retries: 500ms, 1s, 2s. Short on purpose
/// — the drain runs inside the finish handler and we do not want to hold the
/// workspace open for minutes when GitHub is having a bad afternoon.
const RETRY_BACKOFFS: &[Duration] = &[
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

/// Public entry point: read pending/failed rows for `task_id`, resolve GitHub
/// identity and target repo, then drain in `seq` order using the real `gh` CLI.
pub async fn drain_pending(
    config: &Arc<RwLock<Config>>,
    pool: &SqlitePool,
    task_id: Uuid,
) -> Result<DrainResult, DrainError> {
    drain_with_executor(config, pool, task_id, &GhCliExecutor).await
}

/// Same as [`drain_pending`] but with an injectable [`ActionExecutor`]. Tests
/// pass a stub; production shares the single `GhCliExecutor`.
pub async fn drain_with_executor<E: ActionExecutor + ?Sized>(
    _config: &Arc<RwLock<Config>>,
    pool: &SqlitePool,
    task_id: Uuid,
    executor: &E,
) -> Result<DrainResult, DrainError> {
    let task = WorkerTask::find_by_id(pool, task_id)
        .await?
        .ok_or(DrainError::TaskNotFound(task_id))?;
    let worker = Worker::find_by_id(pool, task.worker_id).await?;
    let pat = worker.as_ref().and_then(|w| w.github_pat.clone());

    let mut done = 0usize;
    let mut failed = 0usize;
    let mut halted = false;

    let pending = AgentAction::find_pending_or_failed_for_task(pool, task_id).await?;
    for row in pending {
        // Cache repo lookups per row — cheap and keeps the loop straight.
        let repo = Repo::find_by_id(pool, row.repo_id)
            .await?
            .ok_or(DrainError::RepoNotFound(row.repo_id))?;
        let owner_repo =
            resolve_owner_repo(&repo).map_err(|message| DrainError::RepoRemoteResolution {
                repo_id: repo.id,
                message,
            })?;

        let declaration: AgentActionDeclaration =
            serde_json::from_str(&row.payload).map_err(|e| DrainError::InvalidPayload {
                action_id: row.id,
                seq: row.seq,
                message: e.to_string(),
            })?;

        let mut last_failure: Option<ExecutorFailure> = None;
        let mut total_attempts = row.attempts;
        let mut outcome: Option<ExecutedAction> = None;

        for attempt in 0..MAX_ATTEMPTS_PER_DRAIN {
            AgentAction::increment_attempts(pool, row.id).await?;
            total_attempts += 1;
            let result = execute_one(executor, &declaration, &owner_repo, pat.as_deref()).await;
            match result {
                Ok(ok) => {
                    outcome = Some(ok);
                    break;
                }
                Err(f) => {
                    let is_last = attempt + 1 == MAX_ATTEMPTS_PER_DRAIN;
                    let is_infra = matches!(f.kind, FailureKind::Infra);
                    last_failure = Some(f.clone());
                    if !is_infra || is_last {
                        break;
                    }
                    tokio::time::sleep(RETRY_BACKOFFS[attempt.min(RETRY_BACKOFFS.len() - 1)]).await;
                }
            }
        }

        match (outcome, last_failure) {
            (Some(ok), _) => {
                AgentAction::set_done(pool, row.id, ok.result_number, ok.result_url.clone())
                    .await?;
                done += 1;
                info!(
                    task_id = %task_id,
                    action_id = %row.id,
                    seq = row.seq,
                    kind = %row.kind,
                    "Agent action drained OK"
                );
            }
            (None, Some(f)) if matches!(f.kind, FailureKind::Definitive) => {
                AgentAction::set_failed(pool, row.id, &f.message, total_attempts).await?;
                failed += 1;
                warn!(
                    task_id = %task_id,
                    action_id = %row.id,
                    seq = row.seq,
                    kind = %row.kind,
                    "Agent action failed definitively — halting drain: {}",
                    f.message
                );
                halted = true;
                break;
            }
            (None, Some(f)) => {
                warn!(
                    task_id = %task_id,
                    action_id = %row.id,
                    seq = row.seq,
                    kind = %row.kind,
                    attempts = total_attempts,
                    "Agent action hit infra failure after {} attempts — leaving pending: {}",
                    MAX_ATTEMPTS_PER_DRAIN,
                    f.message
                );
                halted = true;
                break;
            }
            (None, None) => {
                unreachable!("loop always produces either an outcome or at least one failure")
            }
        }
    }

    // pending_remaining is a fresh read: it captures anything left over after
    // this drain call (rows we skipped after a halt, plus anything a
    // concurrent process may have inserted). Cheap enough to be worth the
    // extra roundtrip since the answer is what drives the caller's decision.
    let remaining = if halted {
        AgentAction::find_pending_or_failed_for_task(pool, task_id)
            .await?
            .into_iter()
            .filter(|r| r.status == agent_action::STATUS_PENDING)
            .count()
    } else {
        0
    };

    Ok(DrainResult {
        done,
        failed,
        pending_remaining: remaining,
    })
}

async fn execute_one<E: ActionExecutor + ?Sized>(
    executor: &E,
    action: &AgentActionDeclaration,
    owner_repo: &str,
    pat: Option<&str>,
) -> Result<ExecutedAction, ExecutorFailure> {
    match action {
        AgentActionDeclaration::CommentPr { pr, body } => {
            executor.post_pr_comment(owner_repo, *pr, body, pat).await
        }
        AgentActionDeclaration::CommentIssue { issue, body } => {
            executor
                .post_issue_comment(owner_repo, *issue, body, pat)
                .await
        }
    }
}

/// Read the repo's origin remote and extract the GitHub `owner/repo` slug.
/// Any non-GitHub remote surfaces as a definitive error — the F1 action kinds
/// only make sense against GitHub.
fn resolve_owner_repo(repo: &Repo) -> Result<String, String> {
    let git = git::GitService::new();
    let url = git
        .get_remote_url(&repo.path, "origin")
        .map_err(|e| format!("failed to read origin URL: {e}"))?;
    extract_github_nwo(&url).ok_or_else(|| format!("origin `{url}` is not a GitHub URL"))
}

/// Same parse as [`repo_issues::extract_github_nwo`]; duplicated here to keep
/// the module standalone and its ownership clear.
fn extract_github_nwo(url: &str) -> Option<String> {
    let lower = url.to_lowercase();
    let path = if let Some(pos) = lower.find("github.com:") {
        &url[pos + "github.com:".len()..]
    } else if let Some(pos) = lower.find("github.com/") {
        &url[pos + "github.com/".len()..]
    } else {
        return None;
    };
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_end_matches('/');
    if path.matches('/').count() == 1 && !path.starts_with('/') {
        Some(path.to_string())
    } else {
        None
    }
}

/// Wrapper around the `gh` CLI. Every invocation gets the PAT (when set) via
/// `GH_TOKEN`, matching the per-worker credential pattern the reviewer submit
/// path already uses.
pub struct GhCliExecutor;

#[async_trait]
impl ActionExecutor for GhCliExecutor {
    async fn post_pr_comment(
        &self,
        owner_repo: &str,
        pr_number: i64,
        body: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure> {
        run_gh_comment("pr", owner_repo, pr_number, body, pat).await
    }

    async fn post_issue_comment(
        &self,
        owner_repo: &str,
        issue_number: i64,
        body: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure> {
        run_gh_comment("issue", owner_repo, issue_number, body, pat).await
    }
}

async fn run_gh_comment(
    subcommand: &str,
    owner_repo: &str,
    number: i64,
    body: &str,
    pat: Option<&str>,
) -> Result<ExecutedAction, ExecutorFailure> {
    use std::process::Stdio;

    use tokio::io::AsyncWriteExt;

    let gh = match resolve_executable_path("gh").await {
        Some(p) => p,
        None => {
            return Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: "`gh` CLI not on PATH".to_string(),
            });
        }
    };

    // Body via `--body-file -` on stdin so newlines and shell metacharacters
    // travel untouched. Same escaping guarantee as `gh`'s `--body-file <path>`
    // but with no temp-file bookkeeping.
    let number_str = number.to_string();
    let mut cmd = Command::new(&gh);
    cmd.args([
        subcommand,
        "comment",
        number_str.as_str(),
        "--repo",
        owner_repo,
        "--body-file",
        "-",
    ]);
    if let Some(pat) = pat.filter(|s| !s.is_empty()) {
        cmd.env("GH_TOKEN", pat);
        cmd.env("GITHUB_TOKEN", pat);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.no_window();

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: format!("failed to spawn `gh`: {e}"),
            });
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(body.as_bytes()).await {
            return Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: format!("failed to write body to gh stdin: {e}"),
            });
        }
        // Drop closes stdin, which signals EOF to `gh` and lets it proceed.
    }

    let output = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => {
            return Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: format!("failed to wait on `gh`: {e}"),
            });
        }
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // `gh <pr|issue> comment` prints the URL of the created comment on
        // stdout. Anything else (empty, non-URL) still counts as success —
        // GitHub took the write; we just lose the pointer.
        let url = stdout
            .lines()
            .find(|l| l.starts_with("http"))
            .map(String::from);
        return Ok(ExecutedAction {
            result_number: Some(number),
            result_url: url,
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let kind = classify_gh_error(output.status.code(), &stderr);
    Err(ExecutorFailure {
        kind,
        message: if stderr.is_empty() {
            format!(
                "gh {subcommand} comment exited with status {}",
                output
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into())
            )
        } else {
            stderr
        },
    })
}

/// Best-effort classification of a failed `gh` invocation into infra vs
/// definitive so the drain policy can decide whether to retry inline or halt.
///
/// The bar for `Infra` is high on purpose: only errors that are plausibly
/// transient count (rate limits, 5xx, DNS, TLS, timeouts). Everything else —
/// including anything auth/permission-shaped — is treated as `Definitive` so
/// the drain stops and the human sees a legible failure on the row.
pub fn classify_gh_error(exit_code: Option<i32>, stderr: &str) -> FailureKind {
    let lower = stderr.to_ascii_lowercase();

    // `gh` exit code 4 is auth failure — a config bug, not a transient issue.
    if exit_code == Some(4) {
        return FailureKind::Definitive;
    }

    // Definitive markers first: HTTP status codes that mean the request is
    // structurally wrong and will keep failing until the human fixes it.
    for marker in [
        "http 401",
        "http 403",
        "http 404",
        "http 410",
        "http 422",
        "not found",
        "unprocessable",
        "no permission",
        "insufficient permission",
        "must have admin",
        "must have write",
        "bad credentials",
        "must authenticate",
        "authentication failed",
        "unauthorized",
    ] {
        if lower.contains(marker) {
            return FailureKind::Definitive;
        }
    }

    // Everything else with a transient-looking marker is retryable.
    for marker in [
        "http 429",
        "rate limit",
        "http 500",
        "http 502",
        "http 503",
        "http 504",
        "timeout",
        "timed out",
        "connection refused",
        "connection reset",
        "network is unreachable",
        "temporary failure",
        "dns",
        "tls",
        "unable to connect",
    ] {
        if lower.contains(marker) {
            return FailureKind::Infra;
        }
    }

    // Unknown-shape errors are safer to treat as definitive so the human
    // notices instead of us silently burning attempts on something a retry
    // can't fix.
    FailureKind::Definitive
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn config() -> Arc<RwLock<Config>> {
        Arc::new(RwLock::new(Config::default()))
    }

    /// A single-conn `:memory:` pool with migrations applied and FKs disabled.
    /// FKs off after migrating (matches the `usage.rs` test pattern) lets us
    /// insert only the rows the drain actually reads (task + repo), skipping
    /// the workers/workspaces surrounding graph.
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

    /// Seed a repo + task, plus a real on-disk git repo whose `origin` is a
    /// GitHub URL so [`resolve_owner_repo`] resolves cleanly.
    async fn seed_env(pool: &SqlitePool) -> (Uuid, Uuid, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let repo_path = tmp.path().to_path_buf();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo_path)
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/octo/repo.git",
            ])
            .current_dir(&repo_path)
            .output()
            .unwrap();

        let repo_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name, parallel_setup_script)
             VALUES (?1, ?2, ?3, ?3, 0)",
        )
        .bind(repo_id)
        .bind(repo_path.to_string_lossy().to_string())
        .bind("octo-repo")
        .execute(pool)
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        let worker_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO worker_tasks (id, worker_id, repo_id, position, title, prompt, status)
             VALUES (?1, ?2, ?3, 0, 't', 'p', 'in_progress')",
        )
        .bind(task_id)
        .bind(worker_id)
        .bind(repo_id)
        .execute(pool)
        .await
        .unwrap();

        (repo_id, task_id, tmp)
    }

    async fn insert_action(
        pool: &SqlitePool,
        task_id: Uuid,
        repo_id: Uuid,
        seq: i64,
        action: &AgentActionDeclaration,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let payload = serde_json::to_string(action).unwrap();
        sqlx::query(
            "INSERT INTO agent_actions (id, task_id, repo_id, seq, kind, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(id)
        .bind(task_id)
        .bind(repo_id)
        .bind(seq)
        .bind(action.kind_str())
        .bind(payload)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// Scripted fake: each call pops the next response from a shared VecDeque
    /// and records the request so tests can assert on ordering.
    #[derive(Debug, Clone)]
    enum FakeResponse {
        Ok(ExecutedAction),
        Err(ExecutorFailure),
    }

    #[derive(Default)]
    struct FakeExecutor {
        responses: Mutex<std::collections::VecDeque<FakeResponse>>,
        calls: Mutex<Vec<(String, i64)>>,
    }

    impl FakeExecutor {
        fn new(responses: Vec<FakeResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn record(&self, kind: &str, number: i64) -> FakeResponse {
            self.calls.lock().unwrap().push((kind.to_string(), number));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("test asked executor for one more response than provided")
        }
    }

    #[async_trait]
    impl ActionExecutor for FakeExecutor {
        async fn post_pr_comment(
            &self,
            _owner_repo: &str,
            pr_number: i64,
            _body: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("comment_pr", pr_number) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }

        async fn post_issue_comment(
            &self,
            _owner_repo: &str,
            issue_number: i64,
            _body: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("comment_issue", issue_number) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }
    }

    #[tokio::test]
    async fn drains_in_seq_order_and_marks_all_done() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        // Insert two actions in non-monotonic insertion order to confirm the
        // drain sorts by seq, not by insertion time.
        insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CommentIssue {
                issue: 20,
                body: "second".into(),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CommentPr {
                pr: 10,
                body: "first".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(10),
                result_url: Some("https://x/1".into()),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(20),
                result_url: Some("https://x/2".into()),
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(
            result,
            DrainResult {
                done: 2,
                failed: 0,
                pending_remaining: 0
            }
        );
        let calls = fake.calls.lock().unwrap();
        assert_eq!(
            calls[..],
            [("comment_pr".into(), 10), ("comment_issue".into(), 20)]
        );
    }

    #[tokio::test]
    async fn definitive_failure_halts_drain_and_leaves_later_actions_pending() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        let id0 = insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CommentPr {
                pr: 1,
                body: "ok".into(),
            },
        )
        .await;
        let id1 = insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CommentPr {
                pr: 2,
                body: "boom".into(),
            },
        )
        .await;
        let id2 = insert_action(
            &pool,
            task_id,
            repo_id,
            2,
            &AgentActionDeclaration::CommentPr {
                pr: 3,
                body: "never runs".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(1),
                result_url: None,
            }),
            FakeResponse::Err(ExecutorFailure {
                kind: FailureKind::Definitive,
                message: "HTTP 404: not found".into(),
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 1);
        assert_eq!(result.failed, 1);
        // The third row is still pending after the halt.
        assert_eq!(result.pending_remaining, 1);

        let rows = AgentAction::find_by_task_id(&pool, task_id).await.unwrap();
        let by_id: std::collections::HashMap<_, _> = rows.iter().map(|r| (r.id, r)).collect();
        assert_eq!(by_id[&id0].status, agent_action::STATUS_DONE);
        assert_eq!(by_id[&id1].status, agent_action::STATUS_FAILED);
        assert_eq!(by_id[&id2].status, agent_action::STATUS_PENDING);
    }

    #[tokio::test]
    async fn infra_failure_retries_within_drain_and_recovers() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        let id0 = insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CommentPr {
                pr: 1,
                body: "flaky".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: "HTTP 503".into(),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(1),
                result_url: None,
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 1);
        assert_eq!(result.failed, 0);

        let row = AgentAction::find_by_task_id(&pool, task_id).await.unwrap()[0].clone();
        assert_eq!(row.id, id0);
        assert_eq!(row.status, agent_action::STATUS_DONE);
        // 2 attempts total (one 503 + one success). attempts starts at 0.
        assert_eq!(row.attempts, 2);
    }

    #[tokio::test]
    async fn infra_failure_exhausts_retries_and_leaves_row_pending() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CommentPr {
                pr: 1,
                body: "always down".into(),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CommentPr {
                pr: 2,
                body: "never runs".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: "HTTP 500".into(),
            }),
            FakeResponse::Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: "HTTP 500".into(),
            }),
            FakeResponse::Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: "HTTP 500".into(),
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.pending_remaining, 2);

        let rows = AgentAction::find_by_task_id(&pool, task_id).await.unwrap();
        assert!(
            rows.iter()
                .all(|r| r.status == agent_action::STATUS_PENDING)
        );
    }

    #[test]
    fn classify_definitive_http_errors() {
        for stderr in [
            "HTTP 404: Not Found",
            "HTTP 422: Validation Failed",
            "HTTP 403: forbidden",
            "must have admin permission",
            "Bad credentials",
        ] {
            assert_eq!(
                classify_gh_error(Some(1), stderr),
                FailureKind::Definitive,
                "expected definitive for `{stderr}`"
            );
        }
    }

    #[test]
    fn classify_infra_errors() {
        for stderr in [
            "HTTP 429: rate limit exceeded",
            "HTTP 502: Bad Gateway",
            "connection reset by peer",
            "request timed out",
            "temporary failure in name resolution",
        ] {
            assert_eq!(
                classify_gh_error(Some(1), stderr),
                FailureKind::Infra,
                "expected infra for `{stderr}`"
            );
        }
    }

    #[test]
    fn classify_unknown_error_is_definitive() {
        // Prefer surfacing weird failures to the human over silently retrying
        // something a retry cannot fix.
        assert_eq!(
            classify_gh_error(Some(1), "gh: some weird message"),
            FailureKind::Definitive
        );
    }

    #[test]
    fn classify_exit_code_four_is_auth_definitive() {
        assert_eq!(
            classify_gh_error(Some(4), "you need to authenticate"),
            FailureKind::Definitive
        );
    }

    #[test]
    fn extract_nwo_from_https_and_ssh() {
        assert_eq!(
            extract_github_nwo("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            extract_github_nwo("git@github.com:owner/repo").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(extract_github_nwo("https://gitlab.com/x/y.git"), None);
    }
}
