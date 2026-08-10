//! Drain the `agent_actions` outbox for a task against GitHub
//! (AGENT-ACTIONS-SPEC.md, F1/F2).
//!
//! The ingest step [`agent_actions_ingest`] persists one row per declared
//! action; this module actually **runs** them, in strict `seq` order, using
//! server-side identity (the worker's PAT when configured; otherwise the
//! machine's `gh auth` credentials). Success flips the row to `done`; a
//! definitive failure flips it to `failed` and **halts** the drain — the
//! remaining rows stay `pending` so the surgical retry endpoint (next issue in
//! the series) can re-drive them without re-running the agent.
//!
//! Catalogue: F1 shipped `comment_pr` and `comment_issue`; F2 adds
//! `create_milestone`, `create_issue` and `close_issue`. All five are
//! best-effort side effects on GitHub, not authoritative writes. Infra hiccups
//! (rate limits, 5xx, transient network) are retried inline with a short
//! exponential backoff before we give up and leave the row `pending`;
//! definitive HTTP failures (404, 422, permissions) short-circuit the drain
//! immediately.
//!
//! F2 also introduces cross-action placeholders — a `create_issue` can
//! reference the milestone number created by an earlier `create_milestone` via
//! `{{action[N].number}}` / `{{action[N].url}}`. Resolution happens **before**
//! each action executes: if the referenced action failed, is still pending, is
//! out-of-range or is a forward reference, the current row is marked `failed`
//! and the drain halts, so raw `{{...}}` text can never reach GitHub.

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

use crate::services::{
    agent_actions_ingest::{AgentActionDeclaration, IssueRef},
    config::Config,
};

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

    async fn create_milestone(
        &self,
        owner_repo: &str,
        title: &str,
        description: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure>;

    async fn create_issue(
        &self,
        owner_repo: &str,
        title: &str,
        body: &str,
        labels: &[String],
        milestone_number: Option<i64>,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure>;

    async fn close_issue(
        &self,
        owner_repo: &str,
        issue_number: i64,
        reason: &str,
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

    // Snapshot of every row for the task, keyed by `seq`. Placeholder
    // resolution walks this map to look up `result_number` / `result_url` from
    // earlier actions; we refresh a row in-memory each time we mark it done so
    // later actions in the same drain see the value without re-querying.
    let all_rows = AgentAction::find_by_task_id(pool, task_id).await?;
    let mut by_seq: std::collections::HashMap<i64, AgentAction> =
        all_rows.into_iter().map(|r| (r.seq, r)).collect();

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

        let mut declaration: AgentActionDeclaration =
            serde_json::from_str(&row.payload).map_err(|e| DrainError::InvalidPayload {
                action_id: row.id,
                seq: row.seq,
                message: e.to_string(),
            })?;

        // Resolve placeholders BEFORE any GitHub call so unresolved `{{...}}`
        // text can never reach the wire. Any failure here is definitive by
        // nature — a broken reference does not get better on retry.
        if let Err(message) =
            resolve_placeholders_in_declaration(&mut declaration, row.seq, &by_seq)
        {
            AgentAction::increment_attempts(pool, row.id).await?;
            AgentAction::set_failed(pool, row.id, &message, row.attempts + 1).await?;
            if let Some(entry) = by_seq.get_mut(&row.seq) {
                entry.status = agent_action::STATUS_FAILED.to_string();
                entry.last_error = Some(message.clone());
                entry.attempts = row.attempts + 1;
            }
            failed += 1;
            warn!(
                task_id = %task_id,
                action_id = %row.id,
                seq = row.seq,
                kind = %row.kind,
                "Agent action failed on placeholder resolution — halting drain: {message}"
            );
            halted = true;
            break;
        }

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
                if let Some(entry) = by_seq.get_mut(&row.seq) {
                    entry.status = agent_action::STATUS_DONE.to_string();
                    entry.result_number = ok.result_number;
                    entry.result_url = ok.result_url.clone();
                    entry.attempts = total_attempts;
                }
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
                if let Some(entry) = by_seq.get_mut(&row.seq) {
                    entry.status = agent_action::STATUS_FAILED.to_string();
                    entry.last_error = Some(f.message.clone());
                    entry.attempts = total_attempts;
                }
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
            let issue = issue_ref_number(issue)?;
            executor
                .post_issue_comment(owner_repo, issue, body, pat)
                .await
        }
        AgentActionDeclaration::CreateMilestone { title, description } => {
            executor
                .create_milestone(owner_repo, title, description, pat)
                .await
        }
        AgentActionDeclaration::CreateIssue {
            title,
            body,
            labels,
            milestone,
        } => {
            let milestone_number = match milestone {
                Some(raw) if !raw.trim().is_empty() => match raw.trim().parse::<i64>() {
                    Ok(n) => Some(n),
                    Err(_) => {
                        return Err(ExecutorFailure {
                            kind: FailureKind::Definitive,
                            message: format!(
                                "campo `milestone` inválido: `{raw}` no es un número entero (esperado un número o un placeholder ya resuelto)"
                            ),
                        });
                    }
                },
                _ => None,
            };
            executor
                .create_issue(owner_repo, title, body, labels, milestone_number, pat)
                .await
        }
        AgentActionDeclaration::CloseIssue { issue, reason } => {
            let issue = issue_ref_number(issue)?;
            executor.close_issue(owner_repo, issue, reason, pat).await
        }
    }
}

/// The issue number behind an [`IssueRef`], after placeholder resolution.
/// A non-numeric leftover is a definitive failure (same contract as the
/// `milestone` field): a value that isn't a number by this point will not
/// get better on retry.
fn issue_ref_number(issue: &IssueRef) -> Result<i64, ExecutorFailure> {
    issue.as_number().map_err(|raw| ExecutorFailure {
        kind: FailureKind::Definitive,
        message: format!(
            "campo `issue` inválido: `{raw}` no es un número entero (esperado un número o un placeholder ya resuelto)"
        ),
    })
}

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

/// Rewrite every `{{action[N].number}}` / `{{action[N].url}}` occurrence in
/// the declaration's string fields with the referenced action's captured
/// result. All string-valued fields are candidates — including the
/// [`IssueRef::Ref`] form of `comment_issue.issue` / `close_issue.issue`,
/// the analyst's primary cross-reference (incidente 10-ago).
///
/// Any error returned here halts the drain: raw `{{...}}` text must never
/// reach GitHub, and a broken reference (forward, out-of-range, referenced
/// action failed) will not get better on retry.
fn resolve_placeholders_in_declaration(
    decl: &mut AgentActionDeclaration,
    current_seq: i64,
    by_seq: &std::collections::HashMap<i64, AgentAction>,
) -> Result<(), String> {
    match decl {
        AgentActionDeclaration::CommentPr { body, .. } => {
            *body = resolve_placeholders_in_str(body, current_seq, by_seq)?;
        }
        AgentActionDeclaration::CommentIssue { issue, body } => {
            if let IssueRef::Ref(raw) = issue {
                *raw = resolve_placeholders_in_str(raw, current_seq, by_seq)?;
            }
            *body = resolve_placeholders_in_str(body, current_seq, by_seq)?;
        }
        AgentActionDeclaration::CreateMilestone { title, description } => {
            *title = resolve_placeholders_in_str(title, current_seq, by_seq)?;
            *description = resolve_placeholders_in_str(description, current_seq, by_seq)?;
        }
        AgentActionDeclaration::CreateIssue {
            title,
            body,
            labels,
            milestone,
        } => {
            *title = resolve_placeholders_in_str(title, current_seq, by_seq)?;
            *body = resolve_placeholders_in_str(body, current_seq, by_seq)?;
            for label in labels.iter_mut() {
                *label = resolve_placeholders_in_str(label, current_seq, by_seq)?;
            }
            if let Some(m) = milestone {
                *m = resolve_placeholders_in_str(m, current_seq, by_seq)?;
            }
        }
        AgentActionDeclaration::CloseIssue { issue, reason } => {
            if let IssueRef::Ref(raw) = issue {
                *raw = resolve_placeholders_in_str(raw, current_seq, by_seq)?;
            }
            *reason = resolve_placeholders_in_str(reason, current_seq, by_seq)?;
        }
    }
    Ok(())
}

/// Walk `input` left-to-right, expanding every `{{action[N].number|url}}`
/// occurrence in place. Any brace pair whose content is not a well-formed
/// placeholder fails the whole substitution — better a legible failure on the
/// row than a partial write to GitHub with `{{...}}` left over.
fn resolve_placeholders_in_str(
    input: &str,
    current_seq: i64,
    by_seq: &std::collections::HashMap<i64, AgentAction>,
) -> Result<String, String> {
    // Fast path: nothing to do if the source contains no template markers.
    if !input.contains("{{") {
        return Ok(input.to_string());
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 2..];
        let close = after_open
            .find("}}")
            .ok_or_else(|| "placeholder mal formado: `{{` sin `}}` de cierre".to_string())?;
        let inner = &after_open[..close];
        let placeholder = format!("{{{{{inner}}}}}");
        let (referenced_seq, field) = parse_placeholder_body(inner).ok_or_else(|| {
            format!(
                "placeholder {placeholder} no reconocido \
                 (formato esperado: `{{{{action[N].number}}}}` o `{{{{action[N].url}}}}`)"
            )
        })?;
        if referenced_seq < 0 || referenced_seq >= current_seq {
            return Err(format!(
                "placeholder {placeholder} no resuelto: \
                 la acción {referenced_seq} está fuera de rango \
                 (solo se pueden referenciar acciones anteriores con seq < {current_seq})"
            ));
        }
        let referenced = by_seq.get(&referenced_seq).ok_or_else(|| {
            format!(
                "placeholder {placeholder} no resuelto: \
                 no existe una acción con seq={referenced_seq} en esta tarea"
            )
        })?;
        match referenced.status.as_str() {
            agent_action::STATUS_DONE => {}
            agent_action::STATUS_FAILED => {
                return Err(format!(
                    "placeholder {placeholder} no resuelto: la acción {referenced_seq} falló"
                ));
            }
            other => {
                return Err(format!(
                    "placeholder {placeholder} no resuelto: \
                     la acción {referenced_seq} está en estado `{other}` (esperado `done`)"
                ));
            }
        }
        let substitution = match field {
            PlaceholderField::Number => referenced
                .result_number
                .map(|n| n.to_string())
                .ok_or_else(|| {
                    format!(
                        "placeholder {placeholder} no resuelto: \
                         la acción {referenced_seq} no capturó ningún `number`"
                    )
                })?,
            PlaceholderField::Url => referenced.result_url.clone().ok_or_else(|| {
                format!(
                    "placeholder {placeholder} no resuelto: \
                     la acción {referenced_seq} no capturó ninguna `url`"
                )
            })?,
        };
        out.push_str(&substitution);
        rest = &after_open[close + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaceholderField {
    Number,
    Url,
}

/// Parse the body between `{{` and `}}`. Returns `(seq, field)` when it
/// matches `action[<n>].(number|url)` (with optional surrounding whitespace);
/// `None` otherwise so the caller can surface a clear error.
fn parse_placeholder_body(body: &str) -> Option<(i64, PlaceholderField)> {
    let trimmed = body.trim();
    let rest = trimmed.strip_prefix("action[")?;
    let close_bracket = rest.find(']')?;
    let seq: i64 = rest[..close_bracket].trim().parse().ok()?;
    let after_bracket = rest[close_bracket + 1..].trim_start();
    let after_dot = after_bracket.strip_prefix('.')?;
    let field = match after_dot.trim() {
        "number" => PlaceholderField::Number,
        "url" => PlaceholderField::Url,
        _ => return None,
    };
    Some((seq, field))
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

    async fn create_milestone(
        &self,
        owner_repo: &str,
        title: &str,
        description: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure> {
        run_gh_create_milestone(owner_repo, title, description, pat).await
    }

    async fn create_issue(
        &self,
        owner_repo: &str,
        title: &str,
        body: &str,
        labels: &[String],
        milestone_number: Option<i64>,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure> {
        run_gh_create_issue(owner_repo, title, body, labels, milestone_number, pat).await
    }

    async fn close_issue(
        &self,
        owner_repo: &str,
        issue_number: i64,
        reason: &str,
        pat: Option<&str>,
    ) -> Result<ExecutedAction, ExecutorFailure> {
        run_gh_close_issue(owner_repo, issue_number, reason, pat).await
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

/// Shared plumbing for `gh` invocations that need to stream a body over stdin
/// (used by every F2 verb — see `--input -` for `gh api` and `--body-file -`
/// for `gh issue create/comment`). Keeps stdin/stdout/stderr handling in one
/// place so each verb can focus on the args and response parsing.
async fn run_gh_with_stdin(
    args: &[&str],
    stdin_body: Option<&[u8]>,
    pat: Option<&str>,
) -> Result<std::process::Output, ExecutorFailure> {
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
    let mut cmd = Command::new(&gh);
    cmd.args(args);
    if let Some(pat) = pat.filter(|s| !s.is_empty()) {
        cmd.env("GH_TOKEN", pat);
        cmd.env("GITHUB_TOKEN", pat);
    }
    if stdin_body.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
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

    if let Some(body) = stdin_body
        && let Some(mut stdin) = child.stdin.take()
    {
        if let Err(e) = stdin.write_all(body).await {
            return Err(ExecutorFailure {
                kind: FailureKind::Infra,
                message: format!("failed to write body to gh stdin: {e}"),
            });
        }
        // Drop closes stdin so `gh` sees EOF and proceeds.
    }

    match child.wait_with_output().await {
        Ok(o) => Ok(o),
        Err(e) => Err(ExecutorFailure {
            kind: FailureKind::Infra,
            message: format!("failed to wait on `gh`: {e}"),
        }),
    }
}

/// Turn a failing `gh` output into a classified [`ExecutorFailure`], reusing
/// the same infra-vs-definitive policy as the comment path.
fn gh_output_failure(context: &str, output: &std::process::Output) -> ExecutorFailure {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let kind = classify_gh_error(output.status.code(), &stderr);
    let message = if stderr.is_empty() {
        format!(
            "{context} exited with status {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        )
    } else {
        stderr
    };
    ExecutorFailure { kind, message }
}

/// POST `/repos/{nwo}/milestones` via `gh api --input -` with a JSON body so
/// newlines / markdown in `description` survive untouched. Captures the new
/// milestone's `number` (needed by placeholder resolution) and `html_url`.
async fn run_gh_create_milestone(
    owner_repo: &str,
    title: &str,
    description: &str,
    pat: Option<&str>,
) -> Result<ExecutedAction, ExecutorFailure> {
    let body =
        serde_json::to_vec(&serde_json::json!({ "title": title, "description": description }))
            .expect("serde_json cannot fail on a String map");
    let api_path = format!("repos/{owner_repo}/milestones");
    let output = run_gh_with_stdin(
        &["api", &api_path, "--method", "POST", "--input", "-"],
        Some(&body),
        pat,
    )
    .await?;

    if !output.status.success() {
        return Err(gh_output_failure("gh api milestones POST", &output));
    }
    let (number, url) = parse_gh_api_number_and_url(&output.stdout);
    Ok(ExecutedAction {
        result_number: number,
        result_url: url,
    })
}

/// POST `/repos/{nwo}/issues` via `gh api --input -` with a JSON body.
///
/// We deliberately avoid `gh issue create --milestone <n>`: the CLI resolves
/// `--milestone` strictly by milestone TITLE (via `MilestoneToID`, which does
/// a case-insensitive string match against each milestone's title), not by
/// number. When the F2 placeholder `{{action[N].number}}` resolves to a
/// number like `77`, `gh issue create --milestone 77` looks for a milestone
/// *titled* `"77"` and fails with `'77' not found`. The REST endpoint accepts
/// `milestone` as an integer, so we skip the CLI-side lookup entirely. The
/// response is JSON with `number` and `html_url` at the top level — same
/// shape [`parse_gh_api_number_and_url`] already handles for milestones.
async fn run_gh_create_issue(
    owner_repo: &str,
    title: &str,
    body: &str,
    labels: &[String],
    milestone_number: Option<i64>,
    pat: Option<&str>,
) -> Result<ExecutedAction, ExecutorFailure> {
    let payload = build_create_issue_payload(title, body, labels, milestone_number);
    let body_bytes =
        serde_json::to_vec(&payload).expect("serde_json cannot fail on this fixed shape");
    let api_path = format!("repos/{owner_repo}/issues");
    let output = run_gh_with_stdin(
        &["api", &api_path, "--method", "POST", "--input", "-"],
        Some(&body_bytes),
        pat,
    )
    .await?;
    if !output.status.success() {
        return Err(gh_output_failure("gh api issues POST", &output));
    }
    let (number, url) = parse_gh_api_number_and_url(&output.stdout);
    Ok(ExecutedAction {
        result_number: number,
        result_url: url,
    })
}

/// Build the JSON body for `POST /repos/{nwo}/issues`. Extracted so a unit
/// test can pin the wire shape — in particular, `milestone` must be a JSON
/// integer (the REST endpoint's contract), not a string, otherwise GitHub
/// answers `422 Unprocessable Entity`. `labels` is omitted entirely when the
/// caller passes an empty slice, to keep the body minimal.
fn build_create_issue_payload(
    title: &str,
    body: &str,
    labels: &[String],
    milestone_number: Option<i64>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "title": title,
        "body": body,
    });
    if !labels.is_empty() {
        payload["labels"] = serde_json::Value::Array(
            labels
                .iter()
                .map(|l| serde_json::Value::String(l.clone()))
                .collect(),
        );
    }
    if let Some(n) = milestone_number {
        payload["milestone"] = serde_json::Value::Number(n.into());
    }
    payload
}

/// Close an issue via `gh issue close`. When `reason` is non-empty, a
/// human-readable comment is posted first via `gh issue comment` — treated as
/// best-effort audit trail, not as GitHub's structural `state_reason`. If the
/// comment fails we still return the failure and skip the close, so the human
/// sees a legible error instead of a "closed silently" outcome.
///
/// Non-idempotency on retry: if the comment succeeds but the close fails,
/// the row is left `failed` and the surgical retry re-runs the whole action
/// — meaning the reason comment gets posted again before the second close
/// attempt. GitHub's issue-comment endpoint is not idempotent, so the issue
/// ends up with duplicated audit comments. This matches the same structural
/// gap the F1 `comment_pr` / `comment_issue` verbs already have; if we ever
/// deduplicate one, deduplicate all three together.
async fn run_gh_close_issue(
    owner_repo: &str,
    issue_number: i64,
    reason: &str,
    pat: Option<&str>,
) -> Result<ExecutedAction, ExecutorFailure> {
    if !reason.trim().is_empty() {
        let comment_out = run_gh_with_stdin(
            &[
                "issue",
                "comment",
                &issue_number.to_string(),
                "--repo",
                owner_repo,
                "--body-file",
                "-",
            ],
            Some(reason.as_bytes()),
            pat,
        )
        .await?;
        if !comment_out.status.success() {
            return Err(gh_output_failure("gh issue comment", &comment_out));
        }
    }
    let close_out = run_gh_with_stdin(
        &[
            "issue",
            "close",
            &issue_number.to_string(),
            "--repo",
            owner_repo,
        ],
        None,
        pat,
    )
    .await?;
    if !close_out.status.success() {
        return Err(gh_output_failure("gh issue close", &close_out));
    }
    Ok(ExecutedAction {
        result_number: Some(issue_number),
        result_url: Some(format!(
            "https://github.com/{owner_repo}/issues/{issue_number}"
        )),
    })
}

/// Parse a JSON object printed by `gh api`, extracting the top-level `number`
/// and `html_url` fields when present. `gh api` prints raw JSON on success
/// for POST/GET endpoints alike; anything unparseable just yields (None, None)
/// — the action still counts as done, we just lose the pointer.
fn parse_gh_api_number_and_url(stdout: &[u8]) -> (Option<i64>, Option<String>) {
    let value: serde_json::Value = match serde_json::from_slice(stdout) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let number = value.get("number").and_then(|v| v.as_i64());
    let url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(String::from);
    (number, url)
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

    /// One executor call as observed by [`FakeExecutor`]. The optional
    /// `payload` slot lets placeholder-resolution tests assert that the
    /// resolved value reached the executor instead of the raw `{{...}}` text.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeCall {
        kind: String,
        number: i64,
        payload: Option<String>,
    }

    #[derive(Default)]
    struct FakeExecutor {
        responses: Mutex<std::collections::VecDeque<FakeResponse>>,
        calls: Mutex<Vec<FakeCall>>,
    }

    impl FakeExecutor {
        fn new(responses: Vec<FakeResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn record(&self, kind: &str, number: i64, payload: Option<String>) -> FakeResponse {
            self.calls.lock().unwrap().push(FakeCall {
                kind: kind.to_string(),
                number,
                payload,
            });
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
            body: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("comment_pr", pr_number, Some(body.to_string())) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }

        async fn post_issue_comment(
            &self,
            _owner_repo: &str,
            issue_number: i64,
            body: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("comment_issue", issue_number, Some(body.to_string())) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }

        async fn create_milestone(
            &self,
            _owner_repo: &str,
            title: &str,
            _description: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("create_milestone", 0, Some(title.to_string())) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }

        async fn create_issue(
            &self,
            _owner_repo: &str,
            _title: &str,
            body: &str,
            _labels: &[String],
            milestone_number: Option<i64>,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            let milestone_marker = milestone_number.unwrap_or(-1);
            match self.record("create_issue", milestone_marker, Some(body.to_string())) {
                FakeResponse::Ok(o) => Ok(o),
                FakeResponse::Err(e) => Err(e),
            }
        }

        async fn close_issue(
            &self,
            _owner_repo: &str,
            issue_number: i64,
            reason: &str,
            _pat: Option<&str>,
        ) -> Result<ExecutedAction, ExecutorFailure> {
            match self.record("close_issue", issue_number, Some(reason.to_string())) {
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
                issue: IssueRef::Number(20),
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
        let kinds_and_numbers: Vec<(String, i64)> =
            calls.iter().map(|c| (c.kind.clone(), c.number)).collect();
        assert_eq!(
            kinds_and_numbers[..],
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

    // ---------------- Placeholder resolution -------------------

    fn done_row(seq: i64, number: Option<i64>, url: Option<&str>) -> AgentAction {
        AgentAction {
            id: Uuid::new_v4(),
            task_id: Some(Uuid::new_v4()),
            repo_id: Uuid::new_v4(),
            seq,
            kind: "create_milestone".into(),
            payload: "{}".into(),
            status: agent_action::STATUS_DONE.into(),
            attempts: 1,
            last_error: None,
            result_number: number,
            result_url: url.map(String::from),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn failed_row(seq: i64) -> AgentAction {
        let mut r = done_row(seq, None, None);
        r.status = agent_action::STATUS_FAILED.into();
        r.last_error = Some("boom".into());
        r
    }

    fn pending_row(seq: i64) -> AgentAction {
        let mut r = done_row(seq, None, None);
        r.status = agent_action::STATUS_PENDING.into();
        r
    }

    fn by_seq(rows: Vec<AgentAction>) -> std::collections::HashMap<i64, AgentAction> {
        rows.into_iter().map(|r| (r.seq, r)).collect()
    }

    #[test]
    fn resolve_str_replaces_number_and_url() {
        let rows = by_seq(vec![done_row(
            0,
            Some(42),
            Some("https://x/y/milestone/42"),
        )]);
        let out = resolve_placeholders_in_str(
            "Milestone #{{action[0].number}} en {{action[0].url}}",
            1,
            &rows,
        )
        .unwrap();
        assert_eq!(out, "Milestone #42 en https://x/y/milestone/42");
    }

    #[test]
    fn resolve_str_passes_through_when_no_placeholder() {
        let rows = by_seq(vec![]);
        assert_eq!(
            resolve_placeholders_in_str("plain text", 3, &rows).unwrap(),
            "plain text"
        );
    }

    #[test]
    fn resolve_str_fails_when_referenced_action_failed() {
        let rows = by_seq(vec![failed_row(0)]);
        let err = resolve_placeholders_in_str("m={{action[0].number}}", 1, &rows).unwrap_err();
        assert!(err.contains("acción 0 falló"), "got: {err}");
        assert!(err.contains("{{action[0].number}}"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_on_forward_reference() {
        let rows = by_seq(vec![
            done_row(0, Some(10), None),
            pending_row(1),
            pending_row(2),
        ]);
        let err = resolve_placeholders_in_str("m={{action[2].number}}", 1, &rows).unwrap_err();
        assert!(err.contains("fuera de rango"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_on_self_reference() {
        let rows = by_seq(vec![done_row(0, Some(10), None), pending_row(1)]);
        let err = resolve_placeholders_in_str("m={{action[1].number}}", 1, &rows).unwrap_err();
        assert!(err.contains("fuera de rango"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_on_out_of_range_reference() {
        let rows = by_seq(vec![done_row(0, Some(10), None)]);
        // seq=5 doesn't exist and > current_seq → out-of-range wins.
        let err = resolve_placeholders_in_str("m={{action[5].number}}", 1, &rows).unwrap_err();
        assert!(err.contains("fuera de rango"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_when_referenced_never_captured_number() {
        let rows = by_seq(vec![done_row(0, None, Some("https://x/y"))]);
        let err = resolve_placeholders_in_str("m={{action[0].number}}", 1, &rows).unwrap_err();
        assert!(err.contains("no capturó ningún `number`"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_on_malformed_placeholder() {
        let rows = by_seq(vec![done_row(0, Some(1), None)]);
        let err = resolve_placeholders_in_str("hola {{action[0].taste}}", 1, &rows).unwrap_err();
        assert!(err.contains("no reconocido"), "got: {err}");
        let err = resolve_placeholders_in_str("hola {{owner}}", 1, &rows).unwrap_err();
        assert!(err.contains("no reconocido"), "got: {err}");
    }

    #[test]
    fn resolve_str_fails_on_unclosed_placeholder() {
        let rows = by_seq(vec![done_row(0, Some(1), None)]);
        let err = resolve_placeholders_in_str("hola {{action[0].number", 1, &rows).unwrap_err();
        assert!(err.contains("sin `}}` de cierre"), "got: {err}");
    }

    #[test]
    fn parse_placeholder_body_accepts_expected_shapes() {
        assert_eq!(
            parse_placeholder_body("action[0].number"),
            Some((0, PlaceholderField::Number))
        );
        assert_eq!(
            parse_placeholder_body("  action[12].url  "),
            Some((12, PlaceholderField::Url))
        );
        assert_eq!(parse_placeholder_body("action[0].other"), None);
        assert_eq!(parse_placeholder_body("otro"), None);
    }

    #[test]
    fn build_create_issue_payload_sends_milestone_as_integer() {
        // Reviewer catch: `gh issue create --milestone <n>` matches by title,
        // so we build a JSON body and hit `gh api` directly. The REST endpoint
        // requires `milestone` to be an integer — a string would 422.
        let payload = build_create_issue_payload(
            "backend",
            "do it",
            &["P1".to_string(), "backend".to_string()],
            Some(77),
        );
        assert_eq!(payload["title"], serde_json::json!("backend"));
        assert_eq!(payload["body"], serde_json::json!("do it"));
        assert_eq!(payload["labels"], serde_json::json!(["P1", "backend"]));
        assert_eq!(
            payload["milestone"],
            serde_json::json!(77),
            "milestone must be a JSON integer, not a string"
        );
        assert!(payload["milestone"].is_i64());
    }

    #[test]
    fn build_create_issue_payload_omits_empty_labels_and_missing_milestone() {
        let payload = build_create_issue_payload("t", "b", &[], None);
        assert_eq!(payload["title"], serde_json::json!("t"));
        assert_eq!(payload["body"], serde_json::json!("b"));
        assert!(
            payload.get("labels").is_none(),
            "empty labels must be omitted, not sent as []"
        );
        assert!(
            payload.get("milestone").is_none(),
            "missing milestone must be omitted, not null"
        );
    }

    #[test]
    fn parse_gh_api_number_and_url_reads_top_level_fields() {
        let stdout = br#"{"number": 7, "html_url": "https://gh/x/y/milestone/7", "extra": true}"#;
        let (n, u) = parse_gh_api_number_and_url(stdout);
        assert_eq!(n, Some(7));
        assert_eq!(u.as_deref(), Some("https://gh/x/y/milestone/7"));
    }

    #[test]
    fn parse_gh_api_number_and_url_tolerates_bad_json() {
        let (n, u) = parse_gh_api_number_and_url(b"not json");
        assert_eq!(n, None);
        assert_eq!(u, None);
    }

    // ---------------- Placeholder resolution in the drain loop ---------------

    #[tokio::test]
    async fn drain_resolves_placeholders_across_seqs_and_creates_downstream_issues() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CreateMilestone {
                title: "F2".into(),
                description: "agent actions".into(),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CreateIssue {
                title: "backend".into(),
                body: "milestone={{action[0].number}}, ver {{action[0].url}}".into(),
                labels: vec!["P1".into()],
                milestone: Some("{{action[0].number}}".into()),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            2,
            &AgentActionDeclaration::CreateIssue {
                title: "ui".into(),
                body: "sin placeholder".into(),
                labels: vec![],
                milestone: Some("{{action[0].number}}".into()),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(77),
                result_url: Some("https://gh/o/r/milestone/77".into()),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(100),
                result_url: Some("https://gh/o/r/issues/100".into()),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(101),
                result_url: Some("https://gh/o/r/issues/101".into()),
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 3);
        assert_eq!(result.failed, 0);

        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].kind, "create_milestone");
        assert_eq!(calls[1].kind, "create_issue");
        // milestone number came through resolved from action[0].number = 77.
        assert_eq!(calls[1].number, 77);
        // FakeExecutor::create_issue records the body — verify placeholders
        // in it were resolved (no raw `{{...}}` reached the executor).
        let seq1_body = calls[1].payload.as_deref().unwrap();
        assert_eq!(seq1_body, "milestone=77, ver https://gh/o/r/milestone/77");
        assert!(
            !seq1_body.contains("{{"),
            "raw placeholder leaked: {seq1_body}"
        );

        // Persisted payload stays as declared — resolution happens on the
        // in-memory declaration, not on the row.
        let rows = AgentAction::find_by_task_id(&pool, task_id).await.unwrap();
        let row1 = rows.iter().find(|r| r.seq == 1).unwrap();
        assert!(row1.payload.contains("{{action[0].number}}"));
        assert_eq!(row1.status, agent_action::STATUS_DONE);
    }

    /// Regression: incidente 10-ago (épica F3 de Bea). The analyst's plan
    /// comment targets the issue created in the same run — `issue` carries a
    /// placeholder that must resolve to the created number before execution.
    #[tokio::test]
    async fn drain_resolves_issue_ref_placeholders_in_comment_and_close() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CreateIssue {
                title: "issue 1".into(),
                body: "b".into(),
                labels: vec![],
                milestone: None,
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CommentIssue {
                issue: IssueRef::Ref("{{action[0].number}}".into()),
                body: "plan de la épica".into(),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            2,
            &AgentActionDeclaration::CloseIssue {
                issue: IssueRef::Ref("{{action[0].number}}".into()),
                reason: "completed".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(41),
                result_url: Some("https://gh/o/r/issues/41".into()),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: None,
                result_url: None,
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: None,
                result_url: None,
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 3);
        assert_eq!(result.failed, 0);

        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(calls[1].kind, "comment_issue");
        assert_eq!(calls[1].number, 41, "issue ref must resolve to 41");
        assert_eq!(calls[2].kind, "close_issue");
        assert_eq!(calls[2].number, 41, "issue ref must resolve to 41");
    }

    #[tokio::test]
    async fn drain_fails_dependent_action_on_forward_reference() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CommentIssue {
                issue: IssueRef::Number(5),
                body: "ref al futuro: {{action[3].number}}".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![]);
        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.failed, 1);
        assert_eq!(result.done, 0);
        let rows = AgentAction::find_by_task_id(&pool, task_id).await.unwrap();
        let msg = rows[0].last_error.as_deref().unwrap_or_default();
        assert!(msg.contains("fuera de rango"), "got: {msg}");
        assert!(msg.contains("{{action[3].number}}"), "got: {msg}");
    }

    #[tokio::test]
    async fn drain_new_kinds_execute_via_executor_trait() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CreateMilestone {
                title: "M".into(),
                description: "d".into(),
            },
        )
        .await;
        insert_action(
            &pool,
            task_id,
            repo_id,
            1,
            &AgentActionDeclaration::CloseIssue {
                issue: IssueRef::Number(99),
                reason: "closing per policy".into(),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(1),
                result_url: Some("https://gh/o/r/milestone/1".into()),
            }),
            FakeResponse::Ok(ExecutedAction {
                result_number: Some(99),
                result_url: Some("https://gh/o/r/issues/99".into()),
            }),
        ]);

        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.done, 2);
        assert_eq!(result.failed, 0);
        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(calls[0].kind, "create_milestone");
        assert_eq!(calls[1].kind, "close_issue");
        assert_eq!(calls[1].number, 99);
    }

    #[tokio::test]
    async fn drain_create_issue_fails_when_milestone_placeholder_is_not_numeric() {
        let pool = test_pool().await;
        let (repo_id, task_id, _tmp) = seed_env(&pool).await;

        // Simulate a manually-inserted create_issue whose milestone is a
        // literal non-numeric string (agent authored badly). Placeholder
        // resolution is a no-op (no `{{...}}`) but the executor step must
        // still catch the bad value with a definitive failure.
        insert_action(
            &pool,
            task_id,
            repo_id,
            0,
            &AgentActionDeclaration::CreateIssue {
                title: "t".into(),
                body: "b".into(),
                labels: vec![],
                milestone: Some("not-a-number".into()),
            },
        )
        .await;

        let fake = FakeExecutor::new(vec![]);
        let result = drain_with_executor(&config(), &pool, task_id, &fake)
            .await
            .unwrap();
        assert_eq!(result.failed, 1);
        let rows = AgentAction::find_by_task_id(&pool, task_id).await.unwrap();
        let msg = rows[0].last_error.as_deref().unwrap_or_default();
        assert!(msg.contains("milestone"), "got: {msg}");
    }
}
