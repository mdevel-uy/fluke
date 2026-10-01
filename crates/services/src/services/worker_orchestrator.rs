//! Worker orchestration: turn queued `worker_tasks` into running workspaces
//! and reconcile task state as their PRs move through review.
//!
//! State machine (per worker):
//!
//!   developer role:
//!     queued  ─▶  in_progress  ─▶  in_review  ─▶  done
//!                     │
//!                     └────────────────────────▶  failed  (agent crashed;
//!                                                           worker goes idle,
//!                                                           a human decides)
//!
//!   analyst / reviewer role:
//!     queued  ─▶  in_progress  ─▶  done   (agent finished OK)
//!                     │
//!                     └──────────────────────▶  failed  (agent crashed)
//!
//!   designer role:
//!     queued  ─▶  in_progress  ─▶  in_review  ─▶  done  (user approved the
//!                     │                                  artifact — never
//!                     │                                  automatic)
//!                     └──────────────────────▶  failed  (agent crashed)
//!
//!   A designer's `in_review` keeps the workspace alive so the user can open
//!   the artifact preview and request follow-ups; the workspace is archived
//!   only on approval.
//!
//! A start attempt that fails *before* the agent begins running (missing
//! `default_target_branch`, unreachable target branch, workspace creation
//! error) is transactional: any workspace it created is archived and
//! detached from the worker, and the linked task stays `queued` so the
//! next start can retry it.
//!
//! Worker capacity check for taking a new task:
//!   * no `in_progress` task, AND
//!   * strictly less than `WORKER_MAX_IN_REVIEW` (default 1) `in_review` tasks,
//!   * at least one `queued` task.
//!
//! The default enforces "one worker, one open ticket": a worker only becomes
//! idle when its PR merges (or the task otherwise reaches a terminal state).
//! `review_fix` tasks are exempt because they drain the same PR that occupies
//! the in_review slot — enforcing the cap on them would deadlock the worker
//! (incident 03-ago-2025, PR #386). Ops can raise the cap per instance via
//! `WORKER_MAX_IN_REVIEW` when higher WIP per worker is acceptable.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
};

use db::{
    DBService,
    models::{
        agent_action::{self, AgentAction},
        coding_agent_turn::CodingAgentTurn,
        execution_process::{ExecutionProcess, ExecutionProcessRunReason},
        execution_process_repo_state::ExecutionProcessRepoState,
        plan_cap_hit::PlanCapHit,
        pull_request::PullRequest,
        repo::Repo,
        requests::WorkspaceRepoInput,
        review_round::{self, CreateReviewRound, ReviewRound},
        session::Session,
        worker::{ROLE_ANALYST, ROLE_DESIGNER, ROLE_DEVELOPER, ROLE_REVIEWER, Worker},
        worker_task::{self, CreateWorkerTask, WorkerTask},
        workspace::{CreateWorkspace, Workspace},
        workspace_repo::WorkspaceRepo,
    },
};
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    },
    executors::{BaseCodingAgent, CodingAgent, StandardCodingAgentExecutor},
    model_selector::PermissionPolicy,
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use futures::StreamExt;
use git_host::{
    CreatePrRequest, GitHostError, GitHostProvider, GitHostService, PrReviewCommentInput,
    SubmitPrReviewRequest,
};
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::services::{
    agent_actions_drain, agent_actions_ingest,
    config::Config,
    container::{ContainerError, ContainerService},
    design_artifacts, quick_action_prompts,
    repo_issues::RepoIssuesService,
    review_verdict, territory,
};

pub const DEFAULT_MAX_IN_REVIEW: i64 = 1;
pub const WORKER_MAX_IN_REVIEW_ENV: &str = "WORKER_MAX_IN_REVIEW";

/// Workspaces whose developer agent just finished and whose PR is being
/// published (push + adopt/create + on_pr_open). Held only while the
/// reconciliation window is open — cleared automatically via
/// [`FinalizingGuard`] on every exit path. In-memory on purpose: a server
/// restart wipes it, so a crash during finalization can't leave a stuck flag
/// (issue #494).
static FINALIZING_WORKSPACES: LazyLock<Mutex<HashSet<Uuid>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Is this workspace inside the post-agent PR-publishing window?
///
/// The workspace_summary endpoint calls this so the frontend can distinguish
/// "the agent stopped and the task is stuck" (real stalled state) from "the
/// agent finished and the orchestrator is publishing the PR right now" (a
/// transient step, not a user-actionable stall).
pub fn is_workspace_finalizing(workspace_id: Uuid) -> bool {
    FINALIZING_WORKSPACES
        .lock()
        .map(|set| set.contains(&workspace_id))
        .unwrap_or(false)
}

/// RAII marker for the finalization window opened in
/// [`on_developer_agent_finished`]. Inserting on construction and removing on
/// drop means every early-return branch (success, failure, best-effort exits)
/// releases the flag without explicit bookkeeping — same shape as `defer` in
/// other languages.
struct FinalizingGuard {
    workspace_id: Uuid,
}

impl FinalizingGuard {
    fn new(workspace_id: Uuid) -> Self {
        if let Ok(mut set) = FINALIZING_WORKSPACES.lock() {
            set.insert(workspace_id);
        }
        Self { workspace_id }
    }
}

impl Drop for FinalizingGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = FINALIZING_WORKSPACES.lock() {
            set.remove(&self.workspace_id);
        }
    }
}

/// Final instruction for developer workers: commit and verify; the system
/// handles push and PR creation automatically on run completion.
pub const WORKER_FINAL_INSTRUCTION_TEMPLATE: &str = "\
When you finish the work above, commit your changes with clear messages and \
verify that `pnpm run check` (frontend) or `cargo check` (backend) passes. \
The system will push the branch and open the pull request against \
`{target_branch}` automatically once your run ends — do NOT create the PR \
yourself.";

/// Final instruction for analyst and reviewer workers: produce deliverables,
/// NOT a PR.
pub const NON_DEVELOPER_FINAL_INSTRUCTION: &str = "\
Your deliverable is the issues, plans, or reviews you created — NOT a pull \
request. Do NOT create any PR. When you finish, end with a concise summary of \
what you produced.";

/// Role framing for analyst workers: turn requests into tickets, do not
/// investigate or solve the underlying problem.
pub const ANALYST_ROLE_INSTRUCTION: &str = "\
You are a business analyst, not an engineer. Your job is to turn the request \
above into actionable, well-scoped GitHub issues — NOT to diagnose or solve \
the problem yourself. Explore the codebase only as far as needed to write \
accurate, assignable tickets: correct files/areas, verifiable acceptance \
criteria, disjoint file territories between parallelizable issues, and open \
questions listed for the PM instead of silent assumptions. Do NOT debug, do \
NOT hunt for root causes, and do NOT propose code changes or fixes — the \
assigned developer owns the diagnosis and the solution. \
Your deliverable is the issues (and plan comment) you created via `gh` — NOT \
a pull request. Do NOT create any PR. When you finish, end with a concise \
summary listing the issues you created.";

/// Analyst-only appendix declaring the `.vk/actions.json` outbox contract
/// (AGENT-ACTIONS-SPEC.md, F1+F2 kinds). Appended AFTER
/// [`ANALYST_ROLE_INSTRUCTION`] by [`build_worker_prompt`] so it wins any
/// conflict with earlier "created via `gh`" language — writes now flow
/// through the outbox, which the orchestrator drains with the platform
/// identity.
///
/// Kept out of the worker soul on purpose: soul strings can change per
/// deployment, but the outbox contract is a runtime guarantee the analyst
/// path depends on to route side effects correctly.
///
/// The enumerated kinds are the COMPLETE catalog the drain accepts today
/// (see [`agent_actions_ingest::AgentActionDeclaration`]). Any GitHub write
/// with no outbox kind yet (e.g. `gh issue edit`, which lands with F3) is
/// intentionally left off the ban — otherwise the analyst is stuck with
/// nowhere to route it. In particular `comment_issue` is listed so the
/// analyst's plan-comment deliverable (promised by
/// [`ANALYST_ROLE_INSTRUCTION`]) can also flow through the outbox instead
/// of falling back to `gh issue comment`.
pub const ANALYST_ACTIONS_JSON_CONTRACT: &str = r#"[AGENT ACTIONS — write operations go through `.vk/actions.json`, NOT `gh`]

Do NOT execute the `gh` write commands that already have an outbox kind below (`gh issue create`, `gh api …/milestones`, `gh issue close`, `gh issue comment`, `gh issue edit`, `gh pr comment`). Declare those operations in `.vk/actions.json` at the repo root — the orchestrator will execute them with the correct identity after your run ends. Read-only `gh` calls (`gh issue list`, `gh issue view`, `gh search`, `gh api` for GET) are still fair game for exploring the repo. GitHub writes without an outbox kind yet may keep using `gh` transitionally until a kind is added.

`.vk/actions.json` is a JSON object with an ordered `actions` array. Each entry is one write, executed in the order you list. Below is every kind available to you — the drain also accepts `resolve_review_thread`, which belongs to the reviewer role and is not yours to declare:

{
  "actions": [
    { "kind": "create_milestone", "title": "...", "description": "..." },
    { "kind": "create_issue", "title": "...", "body": "...", "labels": ["P1", "backend"], "milestone": "{{action[0].number}}" },
    { "kind": "comment_issue", "issue": "{{action[1].number}}", "body": "plan comment for the epic — open questions, scope, links to the issues you just created" },
    { "kind": "add_labels", "issue": 456, "labels": ["feature:rss-v1", "wave:2"] },
    { "kind": "update_issue", "issue": 456, "title": "new title (omit to leave unchanged)", "body": "new body (omit to leave unchanged)" },
    { "kind": "close_issue", "issue": 456, "reason": "completed" },
    { "kind": "comment_pr", "pr": 789, "body": "..." }
  ]
}

Placeholders — reference the result of an earlier action by its 0-indexed position in the array:
  * `{{action[N].number}}` — number of the resource created by action N (milestone number, issue number).
  * `{{action[N].url}}` — URL of the resource created by action N.
The `issue` field of `comment_issue` / `close_issue` / `add_labels` / `update_issue` and the `milestone` field of `create_issue` accept either a literal number (`"issue": 123`) or a `{{action[N].number}}` placeholder — use the placeholder to target an issue you create in the same run (e.g. the plan comment on your first created issue). `pr` is always a literal number.
Only BACK references are allowed: `N` must be strictly less than the index of the action that uses the placeholder. Forward references and self-references fail the ingest.

`labels` defaults to `[]` and `milestone` is optional (omit it or use `null` when the issue does not belong to a milestone). Emit the file only if you have write operations to declare; a run with no writes should leave `.vk/actions.json` absent."#;

/// Analyst-only appendix: the execution-label convention.
///
/// The whole "which issues can run in parallel" feature is this text plus a
/// grouped view. There is no dependency graph in the database and no inference
/// engine: the analyst is the only actor that knows the dependency structure
/// at the moment it writes the issues, so it encodes that knowledge as two
/// GitHub labels and the board just groups by them.
///
/// Deliberately verbose about the four same-wave conditions. An analyst that
/// only checks "is there a dependency?" reproduces the 14-ago-2026 RAGaaS
/// finding: two issues that share no file and no dependency still collided at
/// merge over an undecided enum discriminator. Condition 4 exists for that.
pub const ANALYST_EXECUTION_LABELS_CONTRACT: &str = r#"[EXECUTION LABELS — every issue you create MUST carry `feature:` and `wave:`]

A human reads the backlog grouped by these labels to decide which issues to hand to workers in parallel. You are the only actor who knows the dependency structure at the moment you write the issues, so you encode it here. An issue missing these labels cannot be planned: the board shows it apart and it gets run alone.

Emit them in the `labels` array of `create_issue`. Labels that do not exist in the repo yet are created automatically — do not call `gh label create`. To tag an issue that already exists (including issues a human wrote), use the `add_labels` action.

`feature:<slug>` — REQUIRED. One kebab-case slug per coherent body of work, stable across your whole run (e.g. `feature:rss-v1`). Every issue of that effort carries the same slug, including pre-existing issues that belong to it — tag those with `add_labels`.

`wave:<n>` — REQUIRED. Execution order WITHIN the feature, starting at `wave:0`. Wave N may start only once every wave lower than N of the same feature is MERGED.

  What a wave means, and it is the only thing that matters: two issues with the same `feature:` AND the same `wave:` will be handed to two different workers AT THE SAME TIME. Put two issues in the same wave only if ALL FOUR of these hold:
    1. Neither needs the other's code to exist.
    2. They do not modify the same file.
    3. They do not both consume the same serialized resource (see `resource:`).
    4. There is no decision shared between them still open — the shape of a payload, the name of an enum variant, the signature of something both will call. If that decision is unsettled, they are NOT the same wave even when 1-3 hold. Settling it is what the earlier wave is for.

  When unsure about any of the four, give the issue a wave of its own. A wave of one is always correct; a wave of two that was wrong is only discovered at merge, after both workers have already written the code.

  The numbers are relative order, not a count: gaps are fine, and two features number their waves independently. NEVER renumber an issue that already exists — other issues are already labelled relative to those numbers.

`resource:<slug>` — OPTIONAL, and the only label that CROSSES features. Apply it when the issue consumes a repo-global resource that exactly one PR can hold at a time, no matter which feature it belongs to. The canonical case is migration numbering: two issues from two unrelated features that each add a migration will both derive "latest + 1" and collide. Others: a dependency lockfile, a generated types file, a shared enum both extend.
  REUSE the exact slug already in use elsewhere in the repo — check with `gh issue list --label resource:...` or `gh label list` first. `resource:db-migration` and `resource:migration-number` are two different resources as far as the board is concerned, which defeats the point.

Worked example — a feature whose second wave is gated by a decision the first wave makes:
{
  "actions": [
    { "kind": "create_issue", "title": "Generalise the credit ledger", "body": "...", "labels": ["feature:billing-v2", "wave:0", "resource:db-migration", "P1"] },
    { "kind": "create_issue", "title": "Minute packs", "body": "...", "labels": ["feature:billing-v2", "wave:1", "resource:db-migration", "P1"] },
    { "kind": "create_issue", "title": "Retention enforcement", "body": "...", "labels": ["feature:billing-v2", "wave:1", "P2"] },
    { "kind": "add_labels", "issue": 84, "labels": ["feature:billing-v2", "wave:1"] }
  ]
}
The two `wave:1` issues run together: different files, neither needs the other, and the ledger discriminator they both read was settled by `wave:0`. Only `Minute packs` claims `resource:db-migration` in that wave — had `Retention enforcement` also added a migration, the two could NOT share a wave, by condition 3. The `add_labels` entry pulls issue 84, written by a human weeks earlier, into the same feature so it stops being invisible to the plan.

Parallelism ACROSS features is not your concern — two issues of different features are two developers working side by side. `resource:` is the only thing that crosses that line."#;

/// Role framing for designer workers: produce a design artifact, not code.
/// The deliverable is one or more HTML files committed inside the worktree —
/// the UI serves them rendered via `/api/workspaces/{id}/preview/{path}`, so
/// the reviewer can open the mockup straight from the Changes view. Do NOT
/// ask for "Claude artifacts": the worker runs headless and has nowhere to
/// publish one.
pub const DESIGNER_ROLE_INSTRUCTION: &str = "\
You are a UI/UX designer, not an engineer. Your job is to produce a design \
proposal — NOT production code, NOT PRs, NOT GitHub issues. Explore the \
codebase only enough to understand the existing design system and current \
implementation. Your deliverable is one or more design files written inside \
the repository under `design/`: an HTML mockup, wireframe, component \
specification, or user flow — whichever format best communicates the design. \
Keep every HTML file fully self-contained (inline CSS/JS, no external CDNs or \
network requests), and COMMIT the files to the workspace branch — never push \
and never open a PR. When you finish, end with a concise summary of the \
design decisions and open questions for the PM, referencing the repo-relative \
path of each file you created (e.g. `design/my-proposal.html`); reviewers \
open them rendered from the workspace Changes view.";

#[derive(Debug, Error)]
pub enum StartError {
    #[error("worker not found")]
    WorkerNotFound,
    #[error("no queued tasks for worker")]
    NothingQueued,
    #[error("worker already has a task in progress")]
    AlreadyInProgress,
    #[error("worker has reached the in-review cap ({0})")]
    InReviewCapReached(i64),
    #[error("licencia suspendida: no se arrancan agentes nuevos")]
    LicenseSuspended,
    #[error("repo not found")]
    RepoNotFound,
    /// The worker's agent has no login on this machine. The task is marked
    /// failed with the same message so it does not sit queued forever.
    #[error("{0}")]
    ProviderDisconnected(String),
    #[error("repo '{0}' has no default_target_branch configured")]
    RepoMissingDefaultBranch(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Container(#[from] ContainerError),
    #[error(transparent)]
    Workspace(#[from] workspace_manager::WorkspaceError),
    #[error(transparent)]
    DbWorkspace(#[from] db::models::workspace::WorkspaceError),
}

impl StartError {
    /// Precondition failures that callers should treat as expected: the
    /// worker just wasn't eligible to start right now (already busy, nothing
    /// queued, or the concurrent cap is full). Auto-start callers swallow
    /// these; the API surfaces them as 409 (or 429 for the cap case).
    pub fn is_conflict(&self) -> bool {
        matches!(
            self,
            StartError::NothingQueued
                | StartError::AlreadyInProgress
                | StartError::InReviewCapReached(_)
                | StartError::LicenseSuspended
        )
    }
}

pub fn max_in_review_from_env() -> i64 {
    std::env::var(WORKER_MAX_IN_REVIEW_ENV)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(DEFAULT_MAX_IN_REVIEW)
}

/// Decide whether the worker can take its next queued task now and return it.
///
/// Enforces the state-machine rule from #472: a worker is idle only when it
/// has neither an `in_progress` task nor `cap` `in_review` tasks. `review_fix`
/// tasks are exempt from the in-review cap — they exist to drain the same PR
/// that occupies the slot, so blocking them would deadlock the worker
/// (in_review waits for the fix, the fix waits for a slot — 03-ago-2025
/// incident, PR #386).
///
/// The cap is passed in (rather than read from env inside) so tests remain
/// isolated from process-global env state, mirroring [`select_lru_reviewer`].
/// Production callers pass [`max_in_review_from_env`].
///
/// Side effect: when the cap turns away a real queued task, records today's
/// `plan_cap_hit` so `/api/metrics` can surface the upsell signal. Cap checks
/// with an empty queue are silent — the worker had nothing to run anyway.
pub(crate) async fn resolve_next_takeable_task(
    pool: &sqlx::SqlitePool,
    worker_id: Uuid,
    cap: i64,
) -> Result<WorkerTask, StartError> {
    if WorkerTask::find_in_progress(pool, worker_id)
        .await?
        .is_some()
    {
        return Err(StartError::AlreadyInProgress);
    }

    let in_review = WorkerTask::count_in_review(pool, worker_id).await?;
    let next_queued = WorkerTask::find_next_queued(pool, worker_id).await?;
    if in_review >= cap {
        let next_is_review_fix = match &next_queued {
            Some(task) => {
                WorkerTask::kind(pool, task.id).await?.as_deref()
                    == Some(worker_task::KIND_REVIEW_FIX)
            }
            None => false,
        };
        if !next_is_review_fix {
            if next_queued.is_some()
                && let Err(e) = PlanCapHit::record_hit_today(pool).await
            {
                warn!(
                    worker_id = %worker_id,
                    "Failed to record plan cap hit: {}",
                    e
                );
            }
            return Err(StartError::InReviewCapReached(cap));
        }
    }

    next_queued.ok_or(StartError::NothingQueued)
}

pub const WORKER_LEAD_ENABLED_ENV: &str = "WORKER_LEAD_ENABLED";
pub const WORKER_REVIEW_MAX_ROUNDS_ENV: &str = "WORKER_REVIEW_MAX_ROUNDS";
/// Last-resort fallback used only when both the env override and the
/// persisted `Config.max_review_rounds` are unusable. Kept in sync with the
/// Config schema default so behavior does not silently diverge.
pub const DEFAULT_MAX_REVIEW_ROUNDS: i64 = 3;

pub fn lead_enabled_from_env() -> bool {
    std::env::var(WORKER_LEAD_ENABLED_ENV)
        .map(|v| v.to_ascii_lowercase() != "false" && v != "0")
        .unwrap_or(true)
}

/// Resolve the maximum number of review rounds per PR.
///
/// Precedence:
/// 1. `WORKER_REVIEW_MAX_ROUNDS` env var — emergency override for ops when
///    the persisted Config is misconfigured. Requires a positive integer.
/// 2. `Config.max_review_rounds` — the user-visible setting.
/// 3. `DEFAULT_MAX_REVIEW_ROUNDS` — hardcoded fallback for the case where
///    Config's value is zero (which the schema default prevents).
///
/// Never panics: unreadable env values fall through to Config, and Config
/// values ≤ 0 fall through to the hardcoded default.
pub fn resolve_max_review_rounds(config: &Config) -> i64 {
    if let Some(env) = std::env::var(WORKER_REVIEW_MAX_ROUNDS_ENV)
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
    {
        return env;
    }
    let from_config = i64::from(config.max_review_rounds);
    if from_config > 0 {
        from_config
    } else {
        DEFAULT_MAX_REVIEW_ROUNDS
    }
}

/// Maximum consecutive infrastructure-failure retries per PR. Beyond this
/// the dispatcher stops retrying and asks for manual intervention — with the
/// exponential backoff below this covers several hours of API outage.
const MAX_INFRA_RETRIES_PER_PR: i64 = 6;
/// From this many consecutive infra failures on, the retry is dispatched
/// with [`INFRA_FALLBACK_MODEL`] instead of the reviewer's own model.
const INFRA_MODEL_FALLBACK_THRESHOLD: i64 = 2;
/// Model the dispatcher degrades to after repeated infra failures. Opus is
/// the fleet's workhorse model and the least likely to be gated: in the
/// 02-ago-2026 incident `fable` returned API 404 for half an hour while
/// opus workers kept running. Claude-only: on any other agent the override
/// degrades to that agent's own default model (see [`pick_worker_model`]).
const INFRA_FALLBACK_MODEL: &str = "opus";

/// How long a task start waits for an agent's model catalog before giving
/// up on validating the worker's model (and trusting it as-is).
const MODEL_CATALOG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Human name of a provider for user-facing messages.
fn provider_name(agent: BaseCodingAgent) -> String {
    match agent {
        BaseCodingAgent::ClaudeCode => "Claude".to_string(),
        BaseCodingAgent::Codex => "Codex".to_string(),
        BaseCodingAgent::Gemini => "Gemini".to_string(),
        other => other.to_string(),
    }
}

/// Model ids `agent` currently offers, from the same discovery the model
/// selector uses (cached, so usually instant). `None` when the catalog
/// cannot be read in time — callers then trust the stored model.
async fn offered_models(agent: &CodingAgent) -> Option<Vec<String>> {
    let fetch = async {
        let mut stream = agent.discover_options(None, None).await.ok()?;
        let mut doc = serde_json::json!({});
        while let Some(patch) = stream.next().await {
            json_patch::patch(&mut doc, &patch).ok()?;
        }
        let models = doc
            .pointer("/options/model_selector/models")?
            .as_array()?
            .iter()
            .filter_map(|m| m.get("id")?.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        Some(models)
    };
    tokio::time::timeout(MODEL_CATALOG_TIMEOUT, fetch)
        .await
        .ok()
        .flatten()
        .filter(|models| !models.is_empty())
}

/// Model to launch a worker task with on `executor`. `None` = the agent's
/// default model. Never returns a model outside `offered` when the catalog
/// is known: a model the agent dropped (or a Claude alias reaching Codex)
/// degrades to the agent's default with a warning.
fn pick_worker_model(
    executor: BaseCodingAgent,
    worker_model: Option<&str>,
    dispatcher_override: Option<&str>,
    offered: Option<&[String]>,
) -> Option<String> {
    let wanted = match dispatcher_override {
        // The dispatcher's infra fallback names a Claude model; any other
        // agent degrades to its own default model instead.
        Some(m) if executor == BaseCodingAgent::ClaudeCode => Some(m),
        Some(_) => None,
        None => worker_model,
    }?;
    match offered {
        Some(models) if !models.iter().any(|m| m == wanted) => {
            warn!(
                executor = %executor,
                model = wanted,
                "Worker model is not offered by its agent; using the agent's default model"
            );
            None
        }
        _ => Some(wanted.to_string()),
    }
}

/// Executor config a worker task launches with: the worker's agent (or the
/// global default), its model validated against that agent's catalog, and
/// the per-worker plan-mode override. `Err(agent)` when the worker pinned an
/// agent that is not connected on this machine.
async fn worker_executor_config(
    global: ExecutorProfileId,
    worker: &Worker,
    dispatcher_override: Option<&str>,
) -> Result<ExecutorConfig, BaseCodingAgent> {
    let executor = worker.executor.unwrap_or(global.executor);
    // The global variant only applies to the global agent; another agent
    // runs its DEFAULT variant.
    let mut executor_config: ExecutorConfig = if executor == global.executor {
        global.into()
    } else {
        ExecutorConfig::new(executor)
    };
    let agent = ExecutorConfigs::get_cached().get_coding_agent(&executor_config.profile_id());
    // Only an explicitly chosen agent is gated: the default agent keeps
    // today's behaviour. ponytail: availability = the executors' own login
    // heuristic (file-based); a stale credential still passes and the CLI
    // fails on its own.
    if worker.executor.is_some()
        && !agent
            .as_ref()
            .is_some_and(|a| a.get_availability_info().is_available())
    {
        return Err(executor);
    }
    let wanted = dispatcher_override.or(worker.model.as_deref());
    let offered = match (&agent, wanted) {
        (Some(agent), Some(_)) => offered_models(agent).await,
        _ => None,
    };
    if let Some(model) = pick_worker_model(
        executor,
        worker.model.as_deref(),
        dispatcher_override,
        offered.as_deref(),
    ) {
        executor_config.model_id = Some(model);
    }
    // Per-worker plan mode override. Setting the policy to `None` is *not*
    // enough to disable plan mode: every executor stores its own `plan`
    // flag in the persisted profile, so a missing override just falls back
    // to that stored value. To truly force plan mode off we have to set a
    // non-plan policy (`Auto`); to force it on we set `Plan`. `None` on the
    // worker means "no override, follow the global setting" — leave the
    // field untouched.
    if let Some(plan_mode) = worker.plan_mode {
        executor_config.permission_policy = Some(if plan_mode {
            PermissionPolicy::Plan
        } else {
            PermissionPolicy::Auto
        });
    }
    Ok(executor_config)
}

/// Exponential backoff between infra-failure retries: 2, 4, 8, 16, 30, 30…
/// minutes. The PR monitor polls every minute; this gate is what keeps a
/// doomed configuration from burning a dispatch per poll.
fn infra_retry_backoff(trailing_failures: i64) -> chrono::Duration {
    let exp = (trailing_failures - 1).clamp(0, 5) as u32;
    chrono::Duration::minutes((2i64 << exp).min(30))
}

/// Substrings (lowercase) in the CLI's final error that identify an
/// infrastructure problem — the agent never really worked, so the failure
/// says nothing about the PR under review.
const INFRA_ERROR_PATTERNS: &[&str] = &[
    "rate limit",
    "usage limit",
    "overloaded",
    "issue with the selected model",
    "credit balance",
    "api key",
    "oauth token",
    "try again later",
];

/// Minimal view of the Claude CLI's final `{"type":"result", …}` stream-json
/// line — enough to distinguish an API-level failure from an agent failure.
#[derive(serde::Deserialize)]
struct CliResultLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    api_error_status: Option<u16>,
}

/// What a failed agent run tells us about itself.
struct AgentFailureDetails {
    /// Human-readable reason shown on the failed card.
    message: String,
    /// True when the run died on an API error (rate limit, model not
    /// available, auth) — an infrastructure failure that must not consume
    /// review rounds and is worth retrying with backoff.
    infra: bool,
}

fn default_failure_details() -> AgentFailureDetails {
    AgentFailureDetails {
        message: "El agente terminó con error".to_string(),
        infra: false,
    }
}

/// Inspect the raw execution logs of a failed run and classify the failure.
/// Falls back to a generic agent-failure when the logs are missing or hold
/// no recognizable final result (e.g. non-Claude executors).
async fn agent_failure_details(
    pool: &sqlx::SqlitePool,
    execution_id: Option<Uuid>,
) -> AgentFailureDetails {
    let Some(execution_id) = execution_id else {
        return default_failure_details();
    };
    let Some(messages) =
        crate::services::execution_process::load_raw_log_messages(pool, execution_id).await
    else {
        return default_failure_details();
    };

    // The final `result` line is the CLI's own verdict on the run; scan from
    // the tail so a long transcript costs nothing.
    for msg in messages.iter().rev() {
        let utils::log_msg::LogMsg::Stdout(chunk) = msg else {
            continue;
        };
        for line in chunk.lines().rev() {
            if let Some(details) = classify_cli_result_line(line) {
                return details;
            }
        }
    }
    default_failure_details()
}

/// Classify one raw stream-json line. Returns `Some` only for a final
/// `{"type":"result", …}` line; anything else is skipped by the caller.
fn classify_cli_result_line(line: &str) -> Option<AgentFailureDetails> {
    let parsed = serde_json::from_str::<CliResultLine>(line.trim()).ok()?;
    if parsed.kind != "result" {
        return None;
    }
    if !parsed.is_error.unwrap_or(false) {
        // The CLI considered the run OK; the failure came from somewhere
        // else (exit code, kill). Nothing to classify.
        return Some(default_failure_details());
    }
    let text = parsed
        .result
        .as_ref()
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("El agente terminó con error");
    let lowered = text.to_lowercase();
    let infra = parsed.api_error_status.is_some()
        || INFRA_ERROR_PATTERNS.iter().any(|p| lowered.contains(p));
    let mut message: String = text.chars().take(400).collect();
    if let Some(status) = parsed.api_error_status {
        message = format!("Error de API ({status}): {message}");
    }
    Some(AgentFailureDetails { message, infra })
}

pub struct StartedTask {
    pub task: WorkerTask,
    pub workspace_id: Uuid,
}

/// Attempt to take the next queued task for the worker. Returns
/// [`StartError::NothingQueued`] when the caller explicitly asked for a
/// start but no task was available.
///
/// The start is transactional: preconditions are validated up front so
/// nothing is created on a cheap-fail path (missing repo,
/// missing `default_target_branch`, etc.). The task is then claimed
/// atomically (`queued` → `in_progress` via a conditional UPDATE) *before*
/// any workspace exists, so concurrent callers — the auto-ingest
/// reconciler, the assign dialog's immediate dispatch, the server's own
/// auto-advance — cannot start the same task twice; losers of that race
/// get [`StartError::AlreadyInProgress`]. Any failure after the claim
/// rolls back: the workspace (if created) is archived + detached and the
/// task returns to `queued`.
pub async fn try_take_next(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    worker_id: Uuid,
) -> Result<StartedTask, StartError> {
    let pool = &db.pool;

    let worker = Worker::find_by_id(pool, worker_id)
        .await?
        .ok_or(StartError::WorkerNotFound)?;

    // Auto-repair orphan workspaces attached to this worker before applying
    // the capacity guard, so a previous failed start does not block the
    // worker forever (see issue #32).
    reconcile_worker_workspaces(db, worker_id).await?;

    // Gate de licenciamiento: una licencia suspendida no arranca agentes nuevos.
    // Las tareas en curso NO se tocan (se dejan terminar), y el acceso a datos,
    // tablero e historial sigue intacto — esto solo bloquea el spawn. Con
    // licenciamiento desactivado (sin clave embebida, flota actual) el estado es
    // siempre Valid y este check no hace nada.
    if crate::services::licensing::global()
        .evaluation_for_gate()
        .status
        == licensing::LicenseStatus::Suspended
    {
        return Err(StartError::LicenseSuspended);
    }

    let task = resolve_next_takeable_task(pool, worker_id, max_in_review_from_env()).await?;

    let repo = Repo::find_by_id(pool, task.repo_id)
        .await?
        .ok_or(StartError::RepoNotFound)?;

    // Cheap precondition: fail *before* creating any workspace so we do not
    // leak a zombie on a mis-configured repo (see issues #31 + #32).
    let target_branch = repo
        .default_target_branch
        .clone()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| StartError::RepoMissingDefaultBranch(repo.display_name.clone()))?;

    // The dispatcher may pin a fallback model on the task itself (after
    // repeated infra failures); that override beats the worker's model.
    let model_override = WorkerTask::model_override(pool, task.id).await?;
    if let Some(model) = &model_override {
        info!(
            task_id = %task.id,
            model,
            "Dispatcher model override pinned on this task"
        );
    }
    let global_profile = config.read().await.executor_profile.clone();
    let executor_config = match worker_executor_config(
        global_profile,
        &worker,
        model_override.as_deref(),
    )
    .await
    {
        Ok(executor_config) => executor_config,
        Err(agent) => {
            let reason = format!(
                "El proveedor {} no está conectado. Conéctalo en Configuración o elige otro modelo para el worker.",
                provider_name(agent)
            );
            // Fail the task instead of leaving it queued: claim first so
            // a concurrent start cannot pick it up in between.
            if WorkerTask::try_claim(pool, task.id, worker_id).await? {
                WorkerTask::set_failed(pool, task.id, &reason).await?;
            }
            warn!(worker_id = %worker_id, task_id = %task.id, "{reason}");
            return Err(StartError::ProviderDisconnected(reason));
        }
    };

    let workspace_manager = WorkspaceManager::new(db.clone());

    // Claim the task before creating anything. The guards above are
    // read-then-act and a start takes seconds, so two concurrent callers
    // can both reach this point holding the same queued task; the
    // conditional UPDATE lets exactly one of them proceed.
    if !WorkerTask::try_claim(pool, task.id, worker_id).await? {
        return Err(StartError::AlreadyInProgress);
    }

    let workspace_id = Uuid::new_v4();
    let branch_label = task.title.as_str();
    let git_branch_name = container
        .git_branch_from_workspace(&workspace_id, branch_label)
        .await;

    let workspace_name = worker_workspace_name(&worker, &task);
    let workspace = match Workspace::create(
        pool,
        &CreateWorkspace {
            branch: git_branch_name,
            name: Some(workspace_name),
        },
        workspace_id,
    )
    .await
    {
        Ok(workspace) => workspace,
        Err(e) => {
            release_task_claim(db, task.id).await;
            return Err(e.into());
        }
    };

    // Author-fix tasks reference an existing PR via `issue_number` (PR and
    // issue numbers share GitHub's sequence, so a PR-record match is
    // unambiguous). Bind this workspace to the PR's head branch: pushes then
    // use an explicit local:head refspec and the finish handler adopts the
    // existing PR instead of opening a new one. The local branch stays
    // unique, so the author's own worktree never loses its checkout.
    if worker.role == ROLE_DEVELOPER
        && let Some(pr_number) = task.issue_number
    {
        match PullRequest::find_latest_workspace_for_pr(pool, repo.id, pr_number).await {
            Ok(Some(author_ws_id)) => {
                match Workspace::remote_branch_name(pool, author_ws_id).await {
                    Ok(head_branch) => {
                        if let Err(e) =
                            Workspace::set_remote_branch(pool, workspace.id, &head_branch).await
                        {
                            warn!(
                                workspace_id = %workspace.id,
                                pr_number,
                                "Could not bind fix-task workspace to PR head branch: {e}"
                            );
                        } else {
                            info!(
                                workspace_id = %workspace.id,
                                pr_number,
                                head_branch = %head_branch,
                                "Fix-task workspace bound to PR head branch"
                            );
                            // Link the PR to this workspace too (N:M), so the
                            // sidebar / task cards of the fix workspace keep
                            // the PR reference instead of losing it to the
                            // original author workspace.
                            match PullRequest::find_by_repo_and_number(pool, repo.id, pr_number)
                                .await
                            {
                                Ok(Some(pr)) => {
                                    if let Err(e) =
                                        PullRequest::link_workspace(pool, workspace.id, &pr.id)
                                            .await
                                    {
                                        warn!(
                                            workspace_id = %workspace.id,
                                            pr_number,
                                            "Could not link PR to fix-task workspace: {e}"
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => warn!(
                                    workspace_id = %workspace.id,
                                    pr_number,
                                    "Could not look up PR record to link: {e}"
                                ),
                            }
                        }
                    }
                    Err(e) => warn!(
                        workspace_id = %workspace.id,
                        pr_number,
                        "Could not resolve PR head branch from author workspace: {e}"
                    ),
                }
            }
            Ok(None) => {} // plain issue task — nothing to bind
            Err(e) => warn!(
                workspace_id = %workspace.id,
                pr_number,
                "PR lookup failed while starting task: {e}"
            ),
        }
    }

    // Link the task to the workspace *before* attaching it to the worker:
    // from the moment the workspace becomes visible on the worker it is
    // backed by an active task, so a concurrent caller's
    // `reconcile_worker_workspaces` can never archive it mid-start.
    if let Err(e) = WorkerTask::set_workspace_id(pool, task.id, workspace.id).await {
        rollback_workspace(db, workspace.id).await;
        release_task_claim(db, task.id).await;
        return Err(e.into());
    }

    // Attach the workspace to the worker so `active_workspace_id` reflects
    // the busy state during setup. Any failure below rolls this back via
    // `rollback_workspace`.
    if let Err(e) = Worker::attach_workspace(pool, worker.id, workspace.id).await {
        rollback_workspace(db, workspace.id).await;
        release_task_claim(db, task.id).await;
        return Err(e.into());
    }

    // Register the repo through the same workspace_manager path that the UI's
    // POST /api/workspaces/start uses — this writes workspace_repos and
    // validates the target branch exists. Without this the worktree can't
    // be created and the agent surfaces "Workspace has no repositories
    // configured" (see issue #33).
    let mut managed = match workspace_manager
        .load_managed_workspace(workspace.clone())
        .await
    {
        Ok(m) => m,
        Err(e) => {
            rollback_workspace(db, workspace.id).await;
            release_task_claim(db, task.id).await;
            return Err(e.into());
        }
    };

    if let Err(e) = managed
        .add_repository(
            &WorkspaceRepoInput {
                repo_id: repo.id,
                target_branch: target_branch.clone(),
            },
            container.git(),
        )
        .await
    {
        rollback_workspace(db, workspace.id).await;
        release_task_claim(db, task.id).await;
        return Err(e.into());
    }

    let prompt = build_worker_prompt(&worker.soul, &task.prompt, &target_branch, &worker.role);

    // Actually start the agent. This creates the worktree and the coding
    // agent session. If it fails, roll the workspace back so the worker is
    // not stuck and the queued task can be retried.
    if let Err(e) = container
        .start_workspace(&workspace, executor_config, prompt)
        .await
    {
        rollback_workspace(db, workspace.id).await;
        release_task_claim(db, task.id).await;
        error!(
            worker_id = %worker.id,
            task_id = %task.id,
            "Worker task failed to start: {}",
            e
        );
        return Err(e.into());
    }

    // The claim already flipped the task to in_progress and the workspace
    // was linked before the start work; re-read the task for the response.
    let task = WorkerTask::set_status(pool, task.id, worker_task::STATUS_IN_PROGRESS).await?;

    info!(
        worker_id = %worker.id,
        task_id = %task.id,
        workspace_id = %workspace.id,
        "Worker started task"
    );

    Ok(StartedTask {
        task,
        workspace_id: workspace.id,
    })
}

/// Best-effort cleanup for a workspace whose start failed after it was
/// created. Archives the workspace, detaches it from any worker, and
/// clears any lingering worker_task -> workspace link so the worker's
/// capacity guard and the UI both see a clean slate on the next start.
///
/// Errors are logged but not surfaced: the caller is already returning
/// the underlying failure, and losing a cleanup step should never mask
/// the real error.
/// Best-effort undo of a task claim after a failed start. Must run *after*
/// `rollback_workspace` (which clears the task's workspace link) so the
/// guarded UPDATE inside `release_claim` can see the task as unlinked.
async fn release_task_claim(db: &DBService, task_id: Uuid) {
    if let Err(e) = WorkerTask::release_claim(&db.pool, task_id).await {
        warn!(
            task_id = %task_id,
            "Failed to release task claim during rollback: {}",
            e
        );
    }
}

/// Archive a finished or failed worker workspace and detach it from its
/// worker in the same step, so the worker immediately reads as free instead
/// of staying attached to a dead workspace until the next
/// `reconcile_worker_workspaces` happens to run.
pub(crate) async fn archive_and_detach(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
) {
    if let Err(e) = container.archive_workspace(workspace_id).await {
        warn!(workspace_id = %workspace_id, "Failed to archive workspace: {}", e);
    }
    if let Err(e) = Worker::detach_workspace(&db.pool, workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to detach workspace from worker: {}",
            e
        );
    }
}

async fn rollback_workspace(db: &DBService, workspace_id: Uuid) {
    let pool = &db.pool;
    if let Err(e) = Workspace::set_archived(pool, workspace_id, true).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to archive workspace during rollback: {}",
            e
        );
    }
    if let Err(e) = Worker::detach_workspace(pool, workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to detach worker during rollback: {}",
            e
        );
    }
    if let Err(e) = WorkerTask::clear_workspace_link(pool, workspace_id).await {
        warn!(
            workspace_id = %workspace_id,
            "Failed to clear worker_task link during rollback: {}",
            e
        );
    }
}

/// Auto-repair inconsistent worker state: any non-archived workspace that
/// is attached to `worker_id` but has no associated `in_progress` or
/// `in_review` task is treated as a zombie left behind by a previous
/// failed start. Archive it and detach it so it does not block the
/// capacity guard.
///
/// This is idempotent and safe to call before every start attempt.
pub(crate) async fn reconcile_worker_workspaces(
    db: &DBService,
    worker_id: Uuid,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    for ws_id in Worker::active_workspace_ids(pool, worker_id).await? {
        if WorkerTask::workspace_has_active_task(pool, ws_id).await? {
            continue;
        }
        warn!(
            worker_id = %worker_id,
            workspace_id = %ws_id,
            "Auto-repairing orphan workspace attached to worker with no active task"
        );
        if let Err(e) = Workspace::set_archived(pool, ws_id, true).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to archive orphan workspace during auto-repair: {}",
                e
            );
        }
        if let Err(e) = Worker::detach_workspace(pool, ws_id).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to detach orphan workspace during auto-repair: {}",
                e
            );
        }
        if let Err(e) = WorkerTask::clear_workspace_link(pool, ws_id).await {
            warn!(
                workspace_id = %ws_id,
                "Failed to clear worker_task link during auto-repair: {}",
                e
            );
        }
    }
    Ok(())
}

/// Startup sweep: move every `in_progress` worker task that has no live
/// execution behind it out of the zombie state.
///
/// Must be called AFTER `cleanup_orphan_executions()` has already marked
/// stale `running` execution processes as `failed`, so that the running-
/// process check below reliably returns false for killed tasks.
///
/// Decision tree for each zombie task:
///   - No commits produced → re-queue at front (most common case: the
///     agent was killed by a deploy before it finished anything useful).
///   - Commits exist → mark as `failed` so a human can inspect and retry.
///
/// Safety rule: if the execution-state check itself errors, the task is
/// left untouched — a visible zombie is safer than accidentally killing a
/// live run.
pub async fn reconcile_in_progress_tasks(db: &DBService) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let in_progress = WorkerTask::find_all_in_progress(pool).await?;

    for task in in_progress {
        let Some(workspace_id) = task.workspace_id else {
            // In-progress without a workspace is an unexpected inconsistency.
            warn!(
                task_id = %task.id,
                worker_id = %task.worker_id,
                "in_progress worker task has no workspace_id — marking failed (startup recovery)"
            );
            if let Err(e) = WorkerTask::set_failed(
                pool,
                task.id,
                "La task quedó in_progress sin workspace tras un reinicio del server",
            )
            .await
            {
                warn!(
                    task_id = %task.id,
                    "Failed to mark no-workspace task as failed during startup recovery: {}",
                    e
                );
            }
            continue;
        };

        // Safety: skip if there is somehow still a live execution running.
        match ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            pool,
            workspace_id,
        )
        .await
        {
            Ok(true) => {
                warn!(
                    task_id = %task.id,
                    workspace_id = %workspace_id,
                    "in_progress worker task still has a running execution — leaving it alone (startup recovery)"
                );
                continue;
            }
            Err(e) => {
                warn!(
                    task_id = %task.id,
                    workspace_id = %workspace_id,
                    "Could not determine execution state during startup recovery — leaving task alone: {}",
                    e
                );
                continue;
            }
            Ok(false) => {}
        }

        // No live execution: zombie confirmed. Decide re-queue vs. failed.
        let has_commits =
            match ExecutionProcess::workspace_has_any_after_commit(pool, workspace_id).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        task_id = %task.id,
                        workspace_id = %workspace_id,
                        "Could not check commits during startup recovery — leaving task alone: {}",
                        e
                    );
                    continue;
                }
            };

        if has_commits {
            // Agent produced commits before being killed. Mark failed so a
            // human can inspect the workspace and decide whether to retry.
            match WorkerTask::set_failed(
                pool,
                task.id,
                "El server se reinició con el agente a mitad de trabajo (hay commits); \
                 inspeccionar el workspace y decidir si reintentar",
            )
            .await
            {
                Ok(_) => info!(
                    task_id = %task.id,
                    worker_id = %task.worker_id,
                    workspace_id = %workspace_id,
                    "Zombie worker task had commits — marked as failed (restart recovery)"
                ),
                Err(e) => warn!(
                    task_id = %task.id,
                    "Failed to mark zombie task as failed during startup recovery: {}",
                    e
                ),
            }
        } else {
            // No commits: re-queue at the front so the task runs next time
            // the worker is started. Clean up the stale workspace so the
            // capacity guard sees a clear slot.
            match WorkerTask::re_queue_at_front(pool, task.id).await {
                Err(e) => {
                    warn!(
                        task_id = %task.id,
                        "Failed to re-queue zombie task during startup recovery: {}",
                        e
                    );
                    continue;
                }
                Ok(_) => {}
            }
            if let Err(e) = Workspace::set_archived(pool, workspace_id, true).await {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to archive workspace during startup recovery: {}",
                    e
                );
            }
            if let Err(e) = Worker::detach_workspace(pool, workspace_id).await {
                warn!(
                    workspace_id = %workspace_id,
                    "Failed to detach workspace during startup recovery: {}",
                    e
                );
            }
            info!(
                task_id = %task.id,
                worker_id = %task.worker_id,
                workspace_id = %workspace_id,
                "Zombie worker task had no commits — re-queued at front (restart recovery)"
            );
        }
    }
    Ok(())
}

/// Reconcile a workspace PR transitioning to *open*: if the workspace
/// belongs to a developer worker and its linked task is `in_progress`,
/// move the task to `in_review`.
///
/// Analyst and reviewer workspaces are not subject to PR-based lifecycle
/// transitions; if they open a PR by mistake, a warning is logged.
/// Reconcile a PR-open transition AND emit the Web Push "esperando aprobación"
/// (issue #533) when — and only when — the task actually moved to
/// `in_review`. Wrapper around [`on_pr_open`] usable from paths that don't
/// need the boolean upstream but still want the push side effect.
///
/// The push is best-effort (`spawn_notify` is fire-and-forget); this
/// function's own return type collapses back to `Result<(), sqlx::Error>`
/// to keep the caller signature.
pub async fn on_pr_open_and_push(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
) -> Result<(), sqlx::Error> {
    let transitioned = on_pr_open(db, workspace_id).await?;
    if !transitioned {
        return Ok(());
    }
    let Some(service) = container.web_push() else {
        return Ok(());
    };
    let label = match db::models::workspace::Workspace::find_by_id(&db.pool, workspace_id).await {
        Ok(Some(ws)) => ws
            .name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&ws.branch)
            .to_string(),
        _ => workspace_id.to_string(),
    };
    let payload = crate::services::web_push::task_in_review_payload(
        workspace_id,
        &label,
        Some(format!("/workspaces/{}", workspace_id)),
    );
    crate::services::web_push::spawn_notify(service.clone(), payload);
    Ok(())
}

pub async fn on_pr_open(db: &DBService, workspace_id: Uuid) -> Result<bool, sqlx::Error> {
    let pool = &db.pool;
    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(false);
    };
    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(false);
    };
    if task.worker_id != worker_id {
        return Ok(false);
    }

    // Check worker role — only developers follow the PR lifecycle.
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(false);
    };
    if worker.role != ROLE_DEVELOPER {
        warn!(
            worker_id = %worker_id,
            workspace_id = %workspace_id,
            role = %worker.role,
            "Non-developer worker created a PR — pr_monitor will not adopt it"
        );
        return Ok(false);
    }

    if task.status == worker_task::STATUS_IN_PROGRESS {
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_IN_REVIEW).await?;
        info!(
            worker_id = %worker_id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            "Worker task moved to in_review",
        );
        return Ok(true);
    }
    Ok(false)
}

/// Reconcile a workspace PR transitioning to *merged*: flip the linked
/// task to `done` and try to take the next queued task. Returns whether
/// a new task was started.
///
/// Analyst and reviewer workspaces are skipped with a warning if a PR
/// is somehow merged for them — their lifecycle is driven by
/// `on_agent_finished`, not by PRs.
pub async fn on_pr_merged(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let pool = &db.pool;
    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(false);
    };
    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(false);
    };
    if task.worker_id != worker_id {
        return Ok(false);
    }

    // Non-developer workers should not reach here; guard defensively.
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(false);
    };
    if worker.role != ROLE_DEVELOPER {
        warn!(
            worker_id = %worker_id,
            workspace_id = %workspace_id,
            role = %worker.role,
            "Non-developer worker PR merged — ignoring (lifecycle driven by on_agent_finished)"
        );
        return Ok(false);
    }

    if task.status != worker_task::STATUS_DONE {
        WorkerTask::set_status(pool, task.id, worker_task::STATUS_DONE).await?;
        info!(
            worker_id = %worker_id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            "Worker task moved to done",
        );
    }

    match try_take_next(config, db, container, worker_id).await {
        Ok(_) => Ok(true),
        Err(e) if e.is_conflict() => Ok(false),
        Err(StartError::Sqlx(e)) => Err(e),
        Err(e) => {
            warn!(
                worker_id = %worker_id,
                "Failed to auto-take next task after merge: {}",
                e
            );
            Ok(false)
        }
    }
}

/// Read `.vk/actions.json` from the workspace, insert every declared row into
/// the outbox, and drain them against GitHub — the F1 hook that turns declared
/// agent actions into real GitHub side effects (AGENT-ACTIONS-SPEC.md).
///
/// Returns `Ok(true)` when the caller should keep going along the happy path,
/// or `Ok(false)` when the hook marked the task `failed` (invalid file, DB
/// error, or a definitive action failure). On `false` the caller must not
/// overwrite the task status back to done/in_review; archiving and next-task
/// dispatch still run as usual.
///
/// Best-effort on missing plumbing: if the workspace/worktree can no longer be
/// resolved we log a warning and return `Ok(true)` so a lost worktree doesn't
/// mistakenly fail a task whose GitHub side effects it can't check anyway.
async fn hook_agent_actions(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    workspace_id: Uuid,
    task_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let pool = &db.pool;

    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task_id,
            "hook_agent_actions: workspace not found — skipping"
        );
        return Ok(true);
    };
    let Some(container_ref) = workspace.container_ref.clone() else {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task_id,
            "hook_agent_actions: workspace has no container_ref — skipping"
        );
        return Ok(true);
    };
    let Some(workspace_repo) = WorkspaceRepo::find_by_workspace_id(pool, workspace_id)
        .await?
        .into_iter()
        .next()
    else {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task_id,
            "hook_agent_actions: workspace has no repo — skipping"
        );
        return Ok(true);
    };
    let Some(repo) = Repo::find_by_id(pool, workspace_repo.repo_id).await? else {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task_id,
            "hook_agent_actions: repo record missing — skipping"
        );
        return Ok(true);
    };

    let workspace_root = PathBuf::from(container_ref);
    let worktree_path = workspace_root.join(&repo.name);

    // 1. Read + parse `.vk/actions.json` with the same dual-fallback the
    //    review verdict uses. Missing at both paths is a legitimate empty run.
    let actions = match agent_actions_ingest::read_actions(&worktree_path, &workspace_root) {
        Ok(v) => v,
        Err(e) => {
            let reason = format!("Ingest de agent_actions falló: {e}");
            WorkerTask::set_failed(pool, task_id, &reason).await?;
            warn!(task_id = %task_id, "{}", reason);
            return Ok(false);
        }
    };
    if actions.is_empty() {
        return Ok(true);
    }

    // 2. Persist every declared row (INSERT OR IGNORE keeps re-ingest a no-op).
    if let Err(e) = agent_actions_ingest::insert_all(pool, task_id, repo.id, &actions).await {
        let reason = format!("No pude persistir agent_actions: {e}");
        WorkerTask::set_failed(pool, task_id, &reason).await?;
        warn!(task_id = %task_id, "{}", reason);
        return Ok(false);
    }

    // 3. Drain immediately: this is what turns declarations into GitHub effects.
    let drain_result = match agent_actions_drain::drain_pending(config, pool, task_id).await {
        Ok(r) => r,
        Err(e) => {
            let reason = format!("Drenaje de agent_actions falló: {e}");
            WorkerTask::set_failed(pool, task_id, &reason).await?;
            warn!(task_id = %task_id, "{}", reason);
            return Ok(false);
        }
    };

    if drain_result.failed > 0 {
        // Build the failure reason from the first `failed` row (per spec).
        let rows = AgentAction::find_by_task_id(pool, task_id).await?;
        let first_failed = rows
            .iter()
            .find(|r| r.status == agent_action::STATUS_FAILED);
        let reason = match first_failed {
            Some(f) => format!(
                "agent action seq={} kind={} failed: {}",
                f.seq,
                f.kind,
                f.last_error.as_deref().unwrap_or("<sin detalle>")
            ),
            None => "agent action falló durante el drenaje".to_string(),
        };
        WorkerTask::set_failed(pool, task_id, &reason).await?;
        warn!(task_id = %task_id, "{}", reason);
        return Ok(false);
    }

    if drain_result.pending_remaining > 0 {
        // Infra hiccup halted the drain. The rows survive as `pending`; the
        // surgical retry endpoint (siguiente issue) can re-drive them without
        // re-running the agent.
        warn!(
            task_id = %task_id,
            pending = drain_result.pending_remaining,
            done = drain_result.done,
            "Agent actions drain finished with pending rows after infra hiccup"
        );
    } else {
        info!(
            task_id = %task_id,
            done = drain_result.done,
            "Agent actions drained OK"
        );
    }

    Ok(true)
}

/// Reconcile a workspace whose coding-agent run just finished.
///
/// - **Developer workers**: push the branch, adopt or create the PR, then
///   transition the task to `in_review` via `on_pr_open`. On any failure
///   (dirty tree, no commits, push error, PR creation error) the task is
///   marked `failed` immediately — no silent swallowing.
/// - **Analyst / reviewer workers**: transition to `done` or `failed`,
///   archive the workspace, and attempt to auto-start the next queued task.
pub async fn on_agent_finished(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    succeeded: bool,
    execution_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;

    let Some(worker_id) = Worker::find_by_workspace_id(pool, workspace_id).await? else {
        return Ok(());
    };
    let Some(worker) = Worker::find_by_id(pool, worker_id).await? else {
        return Ok(());
    };

    if worker.role == ROLE_DEVELOPER {
        return on_developer_agent_finished(
            config,
            db,
            container,
            workspace_id,
            &worker,
            succeeded,
            execution_id,
        )
        .await;
    }

    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(());
    };
    if task.worker_id != worker_id {
        return Ok(());
    }

    if worker.role == ROLE_REVIEWER && task.status == worker_task::STATUS_IN_PROGRESS {
        return on_reviewer_agent_finished(
            config,
            db,
            container,
            workspace_id,
            &worker,
            &task,
            succeeded,
            execution_id,
        )
        .await;
    }

    // Only transition tasks that are still in_progress. One exception: a
    // designer task awaiting the user's approval (`in_review`) whose
    // workspace just finished a follow-up run — the artifact changed, so
    // refresh the deliverable (summary + design/* ref) without touching the
    // task state. Approval stays a user-only transition.
    if task.status != worker_task::STATUS_IN_PROGRESS {
        if worker.role == ROLE_DESIGNER && task.status == worker_task::STATUS_IN_REVIEW && succeeded
        {
            persist_non_developer_deliverable(
                db,
                container,
                workspace_id,
                &task,
                &worker,
                execution_id,
            )
            .await;
            // A follow-up run may still have declared new agent actions; drain
            // them before returning. Workspace stays alive on failure — the
            // user is the terminal approver of designer artifacts.
            hook_agent_actions(config, db, workspace_id, task.id).await?;
        }
        return Ok(());
    }

    // Designers stop at `in_review`: the user must see the artifact (and
    // possibly request follow-ups) before the task may count as done — the
    // final OK is always the user's, via approve_designer_task.
    let new_status = if !succeeded {
        worker_task::STATUS_FAILED
    } else if worker.role == ROLE_DESIGNER {
        worker_task::STATUS_IN_REVIEW
    } else {
        worker_task::STATUS_DONE
    };

    let mut infra_failure = false;
    let mut actions_failed_task = false;
    if succeeded {
        WorkerTask::set_status(pool, task.id, new_status).await?;
        // Persist what the run left behind BEFORE archiving the worktree:
        // the agent's final message for every non-developer role, plus — for
        // designers that committed work — the branch pushed as a durable
        // `design/*` ref. This is the non-dev analog of the developer's
        // push+PR step: the agent only produces; the system does the plumbing.
        persist_non_developer_deliverable(
            db,
            container,
            workspace_id,
            &task,
            &worker,
            execution_id,
        )
        .await;
        // Drain any declared agent actions (AGENT-ACTIONS-SPEC.md, F1). On
        // definitive failure this overrides the task status to `failed` — a
        // designer that declared an unsatisfiable comment is a failure, not
        // an in_review awaiting approval.
        if !hook_agent_actions(config, db, workspace_id, task.id).await? {
            actions_failed_task = true;
        }
    } else {
        let details = agent_failure_details(pool, execution_id).await;
        infra_failure = details.infra;
        let kind = details.infra.then_some(worker_task::FAILURE_KIND_INFRA);
        WorkerTask::set_failed_with_kind(pool, task.id, &details.message, kind).await?;
    }
    info!(
        worker_id = %worker_id,
        task_id = %task.id,
        workspace_id = %workspace_id,
        role = %worker.role,
        succeeded,
        infra_failure,
        actions_failed_task,
        "Non-developer worker task finished — status set to {}",
        new_status
    );
    if infra_failure {
        warn!(
            worker_id = %worker_id,
            task_id = %task.id,
            "Task failed for infrastructure reasons (API error) — it will not \
             consume a review round; the dispatcher retries with backoff"
        );
    }

    // Archive the workspace now that the task is complete. A designer task
    // that ended in `in_review` is NOT complete: its workspace stays alive so
    // the user can open the artifact preview and request follow-ups; it is
    // archived on approval instead (approve_designer_task). A designer whose
    // agent actions failed drained is no longer `in_review`, so archive too.
    let keep_alive = new_status == worker_task::STATUS_IN_REVIEW && !actions_failed_task;
    if !keep_alive {
        archive_and_detach(db, container, workspace_id).await;
    }

    // Auto-start the next queued task for this worker.
    if succeeded {
        match try_take_next(config, db, container, worker_id).await {
            Ok(_) => {}
            Err(e) if e.is_conflict() => {}
            Err(StartError::Sqlx(e)) => {
                warn!(
                    worker_id = %worker_id,
                    "Failed to auto-take next task after agent finished: {}",
                    e
                );
            }
            Err(e) => {
                warn!(
                    worker_id = %worker_id,
                    "Failed to auto-take next task after agent finished: {}",
                    e
                );
            }
        }
    }

    Ok(())
}

/// Reviewer role, agent just finished: read `.vk/review.json`, validate it,
/// submit the review to GitHub with the reviewer worker's PAT, and update
/// the round row + the developer task's `review_result` in one go.
///
/// Failure modes and their round accounting (spec §A3):
/// - **Agent infra failure** (rate limit, API down, model gated): task
///   `failed` with `failure_kind = infra`, round `failed`. Doesn't burn a
///   round; the dispatcher retries with backoff.
/// - **Agent crashed / no verdict written**: task `failed` (no infra kind),
///   round `failed`. Also doesn't burn a round — the failure came before
///   the reviewer produced anything actionable.
/// - **Invalid `.vk/review.json`**: task `failed` with the parse/schema
///   error as `failure_reason`, round `failed`. Same accounting: no
///   verdict, no round consumed.
/// - **GitHub API failure on submit**: task `failed` with the API error,
///   marked infra (transient); round `failed`. The next dispatch retries.
/// - **Success**: task `done`, round `submitted` with the GitHub review id
///   and verdict; the developer task's `review_result` is written in the
///   same beat (no waiting on `pr_monitor` to poll and discover the
///   verdict); on `request_changes` the author-fix task is dispatched
///   immediately so the loop keeps moving.
async fn on_reviewer_agent_finished(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    worker: &Worker,
    task: &WorkerTask,
    succeeded: bool,
    execution_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;

    let round = ReviewRound::find_by_task_id(pool, task.id).await?;

    // Fail-closed helper: mark task failed, mark round failed, archive the
    // workspace, and offer the worker its next task. Never returns an error;
    // this is the terminal path.
    async fn fail(
        config: &Arc<RwLock<Config>>,
        db: &DBService,
        container: &(impl ContainerService + Send + Sync),
        worker: &Worker,
        task: &WorkerTask,
        round: Option<&ReviewRound>,
        workspace_id: Uuid,
        reason: String,
        infra: bool,
    ) -> Result<(), sqlx::Error> {
        let pool = &db.pool;
        let kind = infra.then_some(worker_task::FAILURE_KIND_INFRA);
        WorkerTask::set_failed_with_kind(pool, task.id, &reason, kind).await?;
        if let Some(round) = round {
            if let Err(e) =
                ReviewRound::set_status(pool, round.id, review_round::STATUS_FAILED).await
            {
                warn!(round_id = %round.id, "Failed to mark review round failed: {}", e);
            }
        }
        info!(
            worker_id = %worker.id,
            task_id = %task.id,
            infra,
            "Reviewer task failed: {}",
            reason
        );
        archive_and_detach(db, container, workspace_id).await;
        match try_take_next(config, db, container, worker.id).await {
            Ok(_) => {}
            Err(e) if e.is_conflict() => {}
            Err(e) => warn!(
                worker_id = %worker.id,
                "Failed to auto-take next task after reviewer failure: {}",
                e
            ),
        }
        Ok(())
    }

    // Agent didn't succeed at all: classify the failure (infra vs agent),
    // record it on the task + round, and bail.
    if !succeeded {
        let details = agent_failure_details(pool, execution_id).await;
        return fail(
            config,
            db,
            container,
            worker,
            task,
            round.as_ref(),
            workspace_id,
            details.message,
            details.infra,
        )
        .await;
    }

    // Agent finished OK — now we need the workspace worktree to read the
    // verdict from, and a PR record to submit against.
    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        return fail(
            config,
            db,
            container,
            worker,
            task,
            round.as_ref(),
            workspace_id,
            "Workspace desapareció antes de leer el veredicto".to_string(),
            true,
        )
        .await;
    };
    let Some(container_ref) = workspace.container_ref.clone() else {
        return fail(
            config,
            db,
            container,
            worker,
            task,
            round.as_ref(),
            workspace_id,
            "El workspace no tiene container_ref — no puedo leer .vk/review.json".to_string(),
            true,
        )
        .await;
    };
    let workspace_repo = WorkspaceRepo::find_by_workspace_id(pool, workspace_id)
        .await?
        .into_iter()
        .next();
    let repo = match &workspace_repo {
        Some(wr) => Repo::find_by_id(pool, wr.repo_id).await?,
        None => None,
    };
    let repo = match repo {
        Some(r) => r,
        None => {
            return fail(
                config,
                db,
                container,
                worker,
                task,
                round.as_ref(),
                workspace_id,
                "No pude resolver el repo del workspace del reviewer".to_string(),
                true,
            )
            .await;
        }
    };
    let workspace_root = PathBuf::from(container_ref);
    let worktree_path = workspace_root.join(&repo.name);

    // Parse + validate `.vk/review.json`. Any error here means the reviewer
    // did not produce a valid verdict → task failed, round failed (spec §A1).
    // The agent's cwd starts at the workspace root (one level above the
    // repo), so a verdict written there instead of at the repo root is
    // accepted too — losing a valid verdict over the cwd ambiguity burned a
    // full re-review (incidente PR #477).
    let mut verdict =
        match review_verdict::read_and_validate_with_fallback(&worktree_path, &workspace_root) {
            Ok(v) => v,
            Err(e) => {
                return fail(
                    config,
                    db,
                    container,
                    worker,
                    task,
                    round.as_ref(),
                    workspace_id,
                    format!("Veredicto inválido: {e}"),
                    false,
                )
                .await;
            }
        };

    // Round row is required to submit: it holds the pinned head SHA the
    // API submission uses as `commit_id`. If it's missing (dispatcher
    // failed to write it earlier), we can't safely submit — the verdict
    // would be pinned to whatever the head is *now*, which may be past the
    // commit the reviewer actually looked at.
    let Some(round) = round else {
        return fail(
            config,
            db,
            container,
            worker,
            task,
            None,
            workspace_id,
            "Falta la fila de review_rounds — no hay SHA pinneado para submitear".to_string(),
            true,
        )
        .await;
    };

    let Some(pr_record) =
        PullRequest::find_by_repo_and_number(pool, repo.id, round.pr_number).await?
    else {
        return fail(
            config,
            db,
            container,
            worker,
            task,
            Some(&round),
            workspace_id,
            "No encontré el PR en la DB local al momento de submitear".to_string(),
            true,
        )
        .await;
    };

    // Submit server-side with the reviewer's PAT (spec §A3). The PAT is
    // required by definition: dispatch_review_task already refuses to
    // dispatch when the reviewer has no PAT.
    let Some(pat) = worker.github_pat.clone() else {
        return fail(
            config,
            db,
            container,
            worker,
            task,
            Some(&round),
            workspace_id,
            "Reviewer perdió el PAT entre el dispatch y el submit".to_string(),
            true,
        )
        .await;
    };
    let git_host = match GitHostService::from_url_with_token(&pr_record.pr_url, Some(pat)) {
        Ok(gh) => gh,
        Err(e) => {
            return fail(
                config,
                db,
                container,
                worker,
                task,
                Some(&round),
                workspace_id,
                format!("No pude construir el cliente GitHub: {e}"),
                true,
            )
            .await;
        }
    };

    let Some(event) = review_verdict::github_event_for(&verdict.verdict) else {
        // Guarded by validate() already; kept as defense-in-depth.
        return fail(
            config,
            db,
            container,
            worker,
            task,
            Some(&round),
            workspace_id,
            format!("Verdict inesperado: {}", verdict.verdict),
            false,
        )
        .await;
    };
    // GitHub validates every inline comment against the PR diff and rejects
    // the WHOLE review with 422 when a single one falls outside it (incidente
    // PR #481: un blocker anclado en un archivo que el PR no tocaba tiró la
    // review entera y el re-review terminó aprobando). Sanitize inline
    // placement against the host's own diff before submitting; items that
    // don't qualify travel in the body instead of killing the round.
    match git_host.get_pr_diff_line_map(&pr_record.pr_url).await {
        Ok(Some(diff)) => {
            let demoted = review_verdict::demote_items_outside_diff(&mut verdict, &diff);
            if demoted > 0 {
                info!(
                    pr_number = round.pr_number,
                    demoted, "Items inline fuera del diff del PR — degradados al body"
                );
            }
        }
        Ok(None) => {}
        Err(e) => warn!(
            pr_number = round.pr_number,
            "No pude traer el diff del PR para validar los comments inline; \
             submiteo sin sanitizar: {e}"
        ),
    }

    let body = review_verdict::compose_body(&verdict);
    let inline: Vec<PrReviewCommentInput> = review_verdict::inline_items(&verdict)
        .into_iter()
        .filter_map(|item| {
            let path = item.path.as_deref()?.trim().to_string();
            let line = item.line?;
            Some(PrReviewCommentInput {
                path,
                line,
                body: item.comment.trim().to_string(),
            })
        })
        .collect();
    let mut submit = SubmitPrReviewRequest {
        pr_url: pr_record.pr_url.clone(),
        commit_id: round.head_sha.clone(),
        event: event.to_string(),
        body,
        comments: inline,
    };
    let submit_result = match git_host.submit_pr_review(&submit).await {
        // Belt-and-braces: if GitHub still 422s an inline placement (e.g.
        // the head moved and the diff we sanitized against is stale), the
        // verdict itself is sound — resubmit once with everything folded
        // into the body instead of burning the round on a re-review.
        Err(e) if !submit.comments.is_empty() && is_unprocessable_entity(&e) => {
            warn!(
                pr_number = round.pr_number,
                "GitHub rechazó la review con comments inline (422); \
                 reintento con todo el veredicto en el body: {e}"
            );
            review_verdict::demote_all_items(&mut verdict);
            submit.comments = Vec::new();
            submit.body = review_verdict::compose_body(&verdict);
            git_host.submit_pr_review(&submit).await
        }
        result => result,
    };
    let response = match submit_result {
        Ok(r) => r,
        Err(e) => {
            let is_env = matches!(
                e,
                GitHostError::AuthFailed(_)
                    | GitHostError::InsufficientPermissions(_)
                    | GitHostError::RepoNotFoundOrNoAccess(_)
            );
            return fail(
                config,
                db,
                container,
                worker,
                task,
                Some(&round),
                workspace_id,
                format!("Falló el submit de la review a GitHub: {e}"),
                // Auth/permissions errors are configuration bugs, not
                // transient infra — don't retry-with-backoff those. Everything
                // else (network, 5xx, 422 on a stale SHA) is worth retrying.
                !is_env,
            )
            .await;
        }
    };

    // The submit had to chase a rename redirect: persist the canonical URL
    // so every later consumer (retries, pr_monitor, fix dispatch) stops
    // hitting 3xx on the stale name (incidente 09-ago: rename del repo dejó
    // los PRs pre-rename fallando el submit con HTTP 307 en loop).
    if let Some(url) = &response.canonical_pr_url {
        info!(
            pr_number = round.pr_number,
            canonical_url = %url,
            "El repo del PR fue renombrado — persisto la URL canónica"
        );
        if let Err(e) = PullRequest::update_pr_url(pool, &pr_record.id, url).await {
            warn!(
                pr_id = %pr_record.id,
                "Failed to persist canonical pr_url after rename redirect: {}",
                e
            );
        }
    }

    // Success. Persist the verdict on the round + the developer task in the
    // same beat so the UI can flip badges without waiting on pr_monitor.
    if let Err(e) = ReviewRound::set_submitted(
        pool,
        round.id,
        Some(&verdict.verdict),
        Some(response.review_id),
    )
    .await
    {
        warn!(
            round_id = %round.id,
            "Failed to mark review round submitted (verdict already on GitHub): {}",
            e
        );
    }
    // Safety net for the rare race where two reviewer rounds ended up
    // pending on the exact same PR head: this verdict already covers the
    // commit, so any sibling in-flight round is redundant. Normally the
    // dispatch guard prevents this from ever happening; when it does, the
    // sibling would otherwise burn budget re-submitting against a commit
    // that already has a verdict.
    if let Err(e) = cancel_sibling_reviewer_rounds_for_head(
        config,
        db,
        container,
        round.repo_id,
        round.pr_number,
        &round.head_sha,
        round.id,
    )
    .await
    {
        warn!(
            round_id = %round.id,
            "Failed to cancel sibling reviewer rounds after verdict submitted: {}",
            e
        );
    }
    WorkerTask::set_status(pool, task.id, worker_task::STATUS_DONE).await?;
    let review_result = match verdict.verdict.as_str() {
        review_verdict::VERDICT_APPROVE => Some("approved"),
        review_verdict::VERDICT_REQUEST_CHANGES => Some("changes_requested"),
        _ => None,
    };
    if let Some(state) = review_result {
        if let Some(dev_task) = find_dev_task_for_pr(pool, round.repo_id, round.pr_number).await {
            if dev_task.review_result.as_deref() != Some(state) {
                if let Err(e) = WorkerTask::set_review_result(pool, dev_task.id, Some(state)).await
                {
                    warn!(
                        dev_task_id = %dev_task.id,
                        "Failed to persist review_result on dev task: {}",
                        e
                    );
                }
            }
            // Auto-transition in_review → approved on the developer's task
            // as soon as the verdict is on file. Same idempotent guard as
            // pr_monitor: only flip while status is still in_review.
            if state == "approved" && dev_task.status == worker_task::STATUS_IN_REVIEW {
                if let Err(e) =
                    WorkerTask::set_status(pool, dev_task.id, worker_task::STATUS_APPROVED).await
                {
                    warn!(
                        dev_task_id = %dev_task.id,
                        "Failed to transition dev task to approved: {}",
                        e
                    );
                }
            }
        }
    }
    info!(
        worker_id = %worker.id,
        task_id = %task.id,
        pr_number = round.pr_number,
        review_id = response.review_id,
        verdict = %verdict.verdict,
        head_sha = %round.head_sha,
        "Review submitted server-side"
    );

    // Drain any declared agent actions (AGENT-ACTIONS-SPEC.md, F1) before
    // archiving the worktree — the file lives there. Definitive failures
    // override the task's `done` back to `failed`, so the human sees the
    // half-run for what it was.
    hook_agent_actions(config, db, workspace_id, task.id).await?;

    archive_and_detach(db, container, workspace_id).await;

    // On request_changes, dispatch the fix task immediately (spec §A3.5):
    // the pr_monitor would eventually do it, but the reviewer's own transition
    // to `done` is the truthful moment — no reason to wait 60s.
    if verdict.verdict == review_verdict::VERDICT_REQUEST_CHANGES {
        if let Some(dev_task) = find_dev_task_for_pr(pool, round.repo_id, round.pr_number).await {
            if let Err(e) = dispatch_author_fix_task(
                config,
                db,
                container,
                round.pr_number,
                round.repo_id,
                dev_task.worker_id,
            )
            .await
            {
                warn!(
                    pr_number = round.pr_number,
                    "Failed to dispatch author fix task after request_changes: {}", e
                );
            }
        }
    }

    match try_take_next(config, db, container, worker.id).await {
        Ok(_) => {}
        Err(e) if e.is_conflict() => {}
        Err(e) => warn!(
            worker_id = %worker.id,
            "Failed to auto-take next task after reviewer finished: {}",
            e
        ),
    }
    Ok(())
}

/// Locate the developer's `WorkerTask` for a PR by walking the latest
/// workspace linked to the PR. Returns `None` when the PR has no workspace
/// (adopted from an external branch) or the workspace has no task attached.
async fn find_dev_task_for_pr(
    pool: &sqlx::SqlitePool,
    repo_id: Uuid,
    pr_number: i64,
) -> Option<WorkerTask> {
    let workspace_id = PullRequest::find_latest_workspace_for_pr(pool, repo_id, pr_number)
        .await
        .ok()
        .flatten()?;
    WorkerTask::find_by_workspace(pool, workspace_id)
        .await
        .ok()
        .flatten()
}

/// The user reviewed a designer's artifact and approved it: flip the task
/// `in_review → done`, close the linked issue (if any), archive its
/// workspace (the durable `design/*` ref and the recorded summary outlive
/// it) and offer the worker its next queued
/// task. This is the ONLY path that completes a designer task — the
/// orchestrator never does it on its own. Role/status validation lives at
/// the route.
pub async fn approve_designer_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    task_id: Uuid,
) -> Result<WorkerTask, sqlx::Error> {
    let pool = &db.pool;
    let task = WorkerTask::set_status(pool, task_id, worker_task::STATUS_DONE).await?;
    info!(
        task_id = %task.id,
        worker_id = %task.worker_id,
        "Designer deliverable approved by user — task moved to done"
    );

    // Designers never open a PR, so there is no "Closes #N" to auto-close the
    // linked issue on merge — the approval gate is the designer's "merge".
    // Document the deliverable on the issue (summary + embedded artifacts)
    // and then close it. Both steps are best-effort: a gh failure must not
    // undo an approval already recorded. This runs BEFORE the workspace is
    // archived so the workspace branch is still resolvable as a ref.
    if let Some(issue_number) = task.issue_number {
        if let Some(body) = build_design_issue_comment(db, container, &task).await {
            if let Err(e) = RepoIssuesService::new()
                .comment_issue(pool, task.repo_id, issue_number, &body)
                .await
            {
                warn!(
                    task_id = %task.id,
                    issue_number,
                    "Design approved but the deliverable could not be documented \
                     on the linked issue: {}",
                    e
                );
            }
        }
        if let Err(e) = RepoIssuesService::new()
            .close_issue(pool, task.repo_id, issue_number)
            .await
        {
            warn!(
                task_id = %task.id,
                issue_number,
                "Design approved but the linked issue could not be closed: {}",
                e
            );
        } else {
            info!(
                task_id = %task.id,
                issue_number,
                "Closed linked issue after design approval"
            );
        }
    }

    if let Some(workspace_id) = task.workspace_id {
        archive_and_detach(db, container, workspace_id).await;
    }

    match try_take_next(config, db, container, task.worker_id).await {
        Ok(_) => {}
        Err(e) if e.is_conflict() => {}
        Err(e) => {
            warn!(
                worker_id = %task.worker_id,
                "Failed to auto-take next task after design approval: {}",
                e
            );
        }
    }
    Ok(task)
}

/// GitHub caps issue comments at 65 536 chars; stop embedding artifacts with
/// enough headroom for the closing fence and footers.
const MAX_DESIGN_COMMENT_LEN: usize = 55_000;
/// Per-artifact embed cap so a single giant mock can't crowd out the rest.
const MAX_ARTIFACT_EMBED_LEN: usize = 20_000;

/// Shortest backtick fence that can safely wrap `content` (a fence must be
/// longer than any backtick run inside the block), never shorter than 4.
fn html_fence(content: &str) -> String {
    let mut max_run = 0usize;
    let mut run = 0usize;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((max_run + 1).max(4))
}

/// Truncate to at most `max_bytes` without splitting a UTF-8 char. Returns
/// the slice and whether anything was cut.
fn truncate_on_char_boundary(s: &str, max_bytes: usize) -> (&str, bool) {
    if s.len() <= max_bytes {
        return (s, false);
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

/// Cuerpo del comentario que deja registrado el deliverable aprobado en el
/// issue: resumen del designer, ref durable y los artefactos HTML embebidos
/// como fuente (recortados para respetar el límite de tamaño del comentario
/// de GitHub). `None` sólo si el repo ya no existe.
async fn build_design_issue_comment(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    task: &WorkerTask,
) -> Option<String> {
    let pool = &db.pool;
    let repo = Repo::find_by_id(pool, task.repo_id).await.ok().flatten()?;
    let git = container.git();

    let mut body = match Worker::find_by_id(pool, task.worker_id).await {
        Ok(Some(worker)) => format!("**Diseño aprobado** — {}\n\n", worker.name),
        _ => String::from("**Diseño aprobado**\n\n"),
    };
    if let Some(summary) = task.result_summary.as_deref() {
        let (summary, truncated) = truncate_on_char_boundary(summary.trim(), 10_000);
        body.push_str(summary);
        if truncated {
            body.push_str("\n\n_(resumen truncado)_");
        }
        body.push_str("\n\n");
    }
    if let Some(deliverable_ref) = &task.deliverable_ref {
        body.push_str(&format!("Deliverable pusheado en `{deliverable_ref}`.\n\n"));
    }

    match design_artifacts::list_artifacts(pool, git, &repo, task).await {
        Ok(Some((oid, files))) => {
            body.push_str("**Artefactos:**\n");
            for file in &files {
                body.push_str(&format!("- `{file}`\n"));
            }
            body.push('\n');
            for file in &files {
                if body.len() >= MAX_DESIGN_COMMENT_LEN {
                    body.push_str(
                        "_(artefactos restantes no embebidos por el límite de \
                         tamaño del comentario — ver el ref del deliverable)_\n",
                    );
                    break;
                }
                let Ok(content) = git.get_commit_file(&repo.path, &oid, file) else {
                    continue;
                };
                let per_file_cap = MAX_ARTIFACT_EMBED_LEN.min(MAX_DESIGN_COMMENT_LEN - body.len());
                let (snippet, truncated) = truncate_on_char_boundary(&content, per_file_cap);
                let fence = html_fence(snippet);
                let footer = if truncated {
                    "_(fuente truncada — el archivo completo está en el ref del deliverable)_\n\n"
                } else {
                    ""
                };
                body.push_str(&format!(
                    "<details>\n<summary><code>{file}</code></summary>\n\n\
                     {fence}html\n{snippet}\n{fence}\n\n{footer}</details>\n\n"
                ));
            }
        }
        Ok(None) => {}
        Err(e) => {
            warn!(
                task_id = %task.id,
                "Failed to enumerate design artifacts for the issue comment: {}",
                e
            );
        }
    }
    Some(body)
}

/// Capture a finished non-developer run's deliverable before its worktree is
/// archived: the agent's final message always; for designers that committed
/// work, additionally push the workspace branch to a durable
/// `design/<n>-<slug>` remote ref. Best-effort by design — a failure here
/// must not fail a task whose work is already done.
async fn persist_non_developer_deliverable(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    task: &WorkerTask,
    worker: &Worker,
    execution_id: Option<Uuid>,
) {
    let pool = &db.pool;
    let summary = agent_result_text(pool, execution_id).await;

    let deliverable_ref = if worker.role == ROLE_DESIGNER {
        push_design_ref(db, container, workspace_id, task, worker).await
    } else {
        None
    };

    if summary.is_none() && deliverable_ref.is_none() {
        return;
    }
    if let Err(e) = WorkerTask::record_deliverable(
        pool,
        task.id,
        summary.as_deref(),
        deliverable_ref.as_deref(),
    )
    .await
    {
        warn!(task_id = %task.id, "Failed to record deliverable: {}", e);
    }
}

/// Push the designer's workspace branch to `design/<n>-<slug>` so the
/// deliverable outlives the archived worktree. Returns the pushed ref name;
/// `None` when there is nothing to push (no commits) or the push failed —
/// the summary alone is still a valid deliverable.
async fn push_design_ref(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    task: &WorkerTask,
    worker: &Worker,
) -> Option<String> {
    let pool = &db.pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await
        .ok()
        .flatten()?;
    let container_ref = workspace.container_ref.clone()?;
    let workspace_repo = WorkspaceRepo::find_by_workspace_id(pool, workspace_id)
        .await
        .ok()?
        .into_iter()
        .next()?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await
        .ok()
        .flatten()?;
    let worktree_path = PathBuf::from(container_ref).join(&repo.name);
    let git = container.git();

    if check_no_new_commits(db, git, workspace_id, &worktree_path).await {
        info!(
            workspace_id = %workspace_id,
            task_id = %task.id,
            "Designer run left no commits — deliverable is the summary only"
        );
        return None;
    }

    let prefix = match task.issue_number {
        Some(n) => n.to_string(),
        None => utils::text::short_uuid(&task.id),
    };
    let ref_name = format!(
        "design/{}-{}",
        prefix,
        utils::text::git_branch_id(&task.title)
    );

    match git.push_to_remote_with_token(
        &worktree_path,
        &workspace.branch,
        &ref_name,
        false,
        worker.github_pat.as_deref(),
    ) {
        Ok(()) => {
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                ref_name = %ref_name,
                "Design deliverable pushed"
            );
            Some(ref_name)
        }
        Err(e) => {
            warn!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "Failed to push design ref '{}': {}",
                ref_name,
                e
            );
            None
        }
    }
}

/// The CLI's own final `result` line for a run that ended OK: the agent's
/// closing message, which non-developer role instructions require to be a
/// concise summary of the deliverable. `None` when the logs are missing or
/// hold no recognizable result (e.g. non-Claude executors).
async fn agent_result_text(pool: &sqlx::SqlitePool, execution_id: Option<Uuid>) -> Option<String> {
    let execution_id = execution_id?;
    let messages =
        crate::services::execution_process::load_raw_log_messages(pool, execution_id).await?;
    for msg in messages.iter().rev() {
        let utils::log_msg::LogMsg::Stdout(chunk) = msg else {
            continue;
        };
        for line in chunk.lines().rev() {
            let Ok(parsed) = serde_json::from_str::<CliResultLine>(line.trim()) else {
                continue;
            };
            if parsed.kind != "result" || parsed.is_error.unwrap_or(false) {
                continue;
            }
            let text = parsed
                .result
                .as_ref()
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            // Cap the stored summary: it is an abstract for cards and prompts,
            // not a transcript.
            return Some(text.chars().take(4000).collect());
        }
    }
    None
}

/// Best-effort push after a follow-up run on a developer task already
/// `in_review`: the PR exists, the agent just added commits (CI fixes,
/// conflict resolution) that must reach the PR head like they would in the
/// normal flow. Never mutates task state — a push failure must not fail a
/// task whose work is already on the PR, and the head may have moved
/// (reviewer edits), which would reject this safety-net push.
///
/// Returns `true` when the push succeeded (so downstream steps like the
/// remediation summary comment can gate on real progress hitting the PR
/// head), `false` otherwise. The task is never marked failed either way.
async fn push_follow_up_commits(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    worker: &Worker,
    task: &WorkerTask,
) -> bool {
    let pool = &db.pool;
    let Ok(Some(workspace)) = Workspace::find_by_id(pool, workspace_id).await else {
        return false;
    };
    let Some(container_ref) = workspace.container_ref.as_ref() else {
        return false;
    };
    let Ok(workspace_repos) = WorkspaceRepo::find_by_workspace_id(pool, workspace_id).await else {
        return false;
    };
    let Some(workspace_repo) = workspace_repos.into_iter().next() else {
        return false;
    };
    let Ok(Some(repo)) = Repo::find_by_id(pool, workspace_repo.repo_id).await else {
        return false;
    };

    let worktree_path = PathBuf::from(container_ref).join(&repo.name);
    let remote_branch = Workspace::remote_branch_name(pool, workspace_id)
        .await
        .unwrap_or_else(|_| workspace.branch.clone());

    match container.git().push_to_remote_with_token(
        &worktree_path,
        &workspace.branch,
        &remote_branch,
        false,
        worker.github_pat.as_deref(),
    ) {
        Ok(()) => {
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                branch = %workspace.branch,
                "Follow-up commits pushed to PR head"
            );
            true
        }
        Err(e) => {
            warn!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "Best-effort follow-up push failed: {}",
                e
            );
            false
        }
    }
}

/// Body of the post-remediation summary comment (REVIEW-LOOP-SPEC bloque B).
///
/// F1 form (degraded per la sad-path del issue #510): sólo el commit SHA corto.
/// Los items del reviewer no están persistidos en la ronda; extenderlos con la
/// enumeración de items es F2, cuando el ledger de agent_actions crezca para
/// llevarlos consigo.
fn build_remediation_summary_body(head_sha: &str) -> String {
    let short_sha: String = head_sha.chars().take(7).collect();
    format!("Remediación completada en {short_sha}.")
}

/// Insert a `comment_pr` outbox row (AGENT-ACTIONS-SPEC.md, F1) resuming the
/// remediation, choosing a `seq` that does not collide with any
/// agent-declared actions already ingested for this task.
async fn enqueue_remediation_summary_action(
    pool: &sqlx::SqlitePool,
    task_id: Uuid,
    repo_id: Uuid,
    pr_number: i64,
    body: &str,
) -> Result<AgentAction, sqlx::Error> {
    let existing = AgentAction::find_by_task_id(pool, task_id).await?;
    let seq = existing.iter().map(|r| r.seq).max().unwrap_or(-1) + 1;

    let payload = serde_json::to_string(&serde_json::json!({
        "kind": "comment_pr",
        "pr": pr_number,
        "body": body,
    }))
    .expect("comment_pr payload always serialises");

    AgentAction::create(
        pool,
        &db::models::agent_action::CreateAgentAction {
            task_id,
            repo_id,
            seq,
            kind: "comment_pr".to_string(),
            payload,
        },
    )
    .await
}

/// Drain a summary-comment action best-effort: pending/failed rows and drain
/// errors log a warn but never touch task state — the push already landed and
/// the comment is cosmético (issue #510, sad-path allowance).
async fn drain_remediation_summary_best_effort<E: agent_actions_drain::ActionExecutor + ?Sized>(
    config: &Arc<RwLock<Config>>,
    pool: &sqlx::SqlitePool,
    task_id: Uuid,
    pr_number: i64,
    executor: &E,
) {
    match agent_actions_drain::drain_with_executor(config, pool, task_id, executor).await {
        Ok(result) if result.failed > 0 || result.pending_remaining > 0 => warn!(
            task_id = %task_id,
            pr_number,
            done = result.done,
            failed = result.failed,
            pending = result.pending_remaining,
            "Remediation summary comment drain finished with pending/failed rows — task NOT failed"
        ),
        Ok(_) => info!(
            task_id = %task_id,
            pr_number,
            "Remediation summary comment posted"
        ),
        Err(e) => warn!(
            task_id = %task_id,
            pr_number,
            "Remediation summary drain error (best-effort, task NOT failed): {}",
            e
        ),
    }
}

/// Post-remediation summary comment (REVIEW-LOOP-SPEC bloque B, issue #510).
///
/// Fires after a successful follow-up push on a dev task already `in_review`
/// when the PR carries a submitted `request_changes` verdict — i.e. this push
/// is closing a reviewer-driven remediation. The system leaves a resumen
/// pointing at the commit that addresses the review, so the last activity on
/// the PR is not just a silent push.
///
/// Best-effort end-to-end: any missing plumbing (no workspace, no PR, no
/// review round with request_changes, unreadable HEAD, DB error, drain
/// failure) logs a warn and returns — the push already landed and the
/// comment is cosmético.
async fn enqueue_remediation_summary_comment(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    task_id: Uuid,
) {
    let pool = &db.pool;

    let Ok(Some(workspace)) = Workspace::find_by_id(pool, workspace_id).await else {
        return;
    };
    let Some(container_ref) = workspace.container_ref.as_ref() else {
        return;
    };
    let Ok(workspace_repos) = WorkspaceRepo::find_by_workspace_id(pool, workspace_id).await else {
        return;
    };
    let Some(workspace_repo) = workspace_repos.into_iter().next() else {
        return;
    };
    let Ok(Some(repo)) = Repo::find_by_id(pool, workspace_repo.repo_id).await else {
        return;
    };

    let prs = match PullRequest::find_by_workspace_id(pool, workspace_id).await {
        Ok(prs) => prs,
        Err(e) => {
            warn!(
                task_id = %task_id,
                "Remediation summary: could not load PRs for workspace: {}",
                e
            );
            return;
        }
    };
    let Some(pr) = prs.into_iter().next() else {
        return;
    };

    // Signal: only fire when the latest submitted review round on this PR was
    // a request_changes verdict. Approvals or a PR that never had a verdict
    // don't get a summary — nothing to resumir.
    match ReviewRound::latest_submitted_review(pool, repo.id, pr.pr_number).await {
        Ok(Some(round))
            if round.verdict.as_deref() == Some(review_round::VERDICT_REQUEST_CHANGES) => {}
        Ok(_) => return,
        Err(e) => {
            warn!(
                task_id = %task_id,
                pr_number = pr.pr_number,
                "Remediation summary: could not load review round: {}",
                e
            );
            return;
        }
    }

    let worktree_path = PathBuf::from(container_ref).join(&repo.name);
    let head_sha = match container.git().get_head_info(&worktree_path) {
        Ok(info) => info.oid,
        Err(e) => {
            warn!(
                task_id = %task_id,
                pr_number = pr.pr_number,
                "Remediation summary: could not read HEAD after push: {}",
                e
            );
            return;
        }
    };

    let body = build_remediation_summary_body(&head_sha);
    if let Err(e) =
        enqueue_remediation_summary_action(pool, task_id, repo.id, pr.pr_number, &body).await
    {
        warn!(
            task_id = %task_id,
            pr_number = pr.pr_number,
            "Remediation summary: could not enqueue comment_pr action: {}",
            e
        );
        return;
    }

    drain_remediation_summary_best_effort(
        config,
        pool,
        task_id,
        pr.pr_number,
        &agent_actions_drain::GhCliExecutor,
    )
    .await;
}

/// Handle a developer worker's agent run completing: push the branch, adopt
/// or create a PR, and transition the task to `in_review`. Any failure
/// (dirty tree, no commits, push error, PR creation error) marks the task
/// `failed` so the human can see the cause and retry.
async fn on_developer_agent_finished(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    workspace_id: Uuid,
    worker: &Worker,
    succeeded: bool,
    execution_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;

    let Some(task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(());
    };
    if task.worker_id != worker.id {
        return Ok(());
    }
    if task.status != worker_task::STATUS_IN_PROGRESS {
        // A run finishing on a task that is no longer in_progress is a manual
        // follow-up (red CI, merge conflicts) on a task already in_review or
        // approved: the orchestrator opened the PR on the first run, so mirror
        // only the plumbing step — push the new commits to the PR head,
        // best-effort, without touching task state or archiving the workspace.
        // Approved is included because a CI failure on an already-approved PR
        // still gets fixed by a follow-up run before merge.
        if succeeded
            && (task.status == worker_task::STATUS_IN_REVIEW
                || task.status == worker_task::STATUS_APPROVED)
        {
            let pushed = push_follow_up_commits(db, container, workspace_id, worker, &task).await;
            // Follow-up runs may still declare new agent actions; drain them
            // too (AGENT-ACTIONS-SPEC.md, F1). Workspace stays alive — the PR
            // is still open and the reviewer/user path is unaffected.
            hook_agent_actions(config, db, workspace_id, task.id).await?;
            // Bloque B del review loop (issue #510): al cerrar una remediación
            // exitosa el sistema deja un comentario resumen en el PR. Se
            // implementa sobre el outbox de agent_actions (primer consumidor
            // sistémico real del F1). Best-effort: cualquier fallo se loguea
            // pero NO falla la task — el push ya está en el PR.
            if pushed {
                enqueue_remediation_summary_comment(config, db, container, workspace_id, task.id)
                    .await;
            }
        }
        return Ok(());
    }

    // Open the finalization window: from here on the task is still `in_progress`
    // in the DB but the orchestrator is about to publish the PR (push +
    // adopt/create + `on_pr_open`). The frontend uses `is_workspace_finalizing`
    // to suppress the "stalled — task in progress, agent stopped" badge during
    // this transient window (issue #494). The guard clears on drop, so every
    // early-return branch below releases it automatically.
    let _finalizing = FinalizingGuard::new(workspace_id);

    if !succeeded {
        let details = agent_failure_details(pool, execution_id).await;
        let kind = details.infra.then_some(worker_task::FAILURE_KIND_INFRA);
        WorkerTask::set_failed_with_kind(pool, task.id, &details.message, kind).await?;
        info!(
            worker_id = %worker.id,
            task_id = %task.id,
            workspace_id = %workspace_id,
            infra_failure = details.infra,
            "Developer worker task failed — agent did not complete successfully"
        );
        archive_and_detach(db, container, workspace_id).await;
        return Ok(());
    }

    // --- agent succeeded: push branch and create PR ---

    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        warn!(workspace_id = %workspace_id, "Workspace not found after agent finished");
        return Ok(());
    };

    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace_id).await?;
    let Some(workspace_repo) = workspace_repos.into_iter().next() else {
        warn!(workspace_id = %workspace_id, "Developer workspace has no repos — marking failed");
        WorkerTask::set_failed(pool, task.id, "El workspace no tiene repos asociados").await?;
        return Ok(());
    };

    let Some(repo) = Repo::find_by_id(pool, workspace_repo.repo_id).await? else {
        warn!(workspace_id = %workspace_id, "Workspace repo record not found — marking failed");
        WorkerTask::set_failed(
            pool,
            task.id,
            "No se encontró el registro del repo del workspace",
        )
        .await?;
        return Ok(());
    };

    let Some(container_ref) = workspace.container_ref.as_ref() else {
        warn!(workspace_id = %workspace_id, "Workspace has no container_ref — marking failed");
        WorkerTask::set_failed(
            pool,
            task.id,
            "El workspace no tiene worktree materializado (container_ref vacío)",
        )
        .await?;
        return Ok(());
    };

    let worktree_path = PathBuf::from(container_ref).join(&repo.name);
    let git = container.git();

    // Fail fast if the agent left uncommitted changes.
    match git.is_worktree_clean(&worktree_path) {
        Ok(false) => {
            warn!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "Developer task ended with uncommitted changes — marking failed"
            );
            WorkerTask::set_failed(
                pool,
                task.id,
                "El agente dejó cambios sin commitear en el worktree",
            )
            .await?;
            archive_and_detach(db, container, workspace_id).await;
            return Ok(());
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "Could not check worktree clean status: {}", e);
        }
        Ok(true) => {}
    }

    // Fail fast if the agent produced no commits above the target branch.
    // Compare current HEAD to the before_head_commit recorded when the
    // execution process started; if identical the agent did nothing useful.
    let no_commits = check_no_new_commits(db, git, workspace_id, &worktree_path).await;
    if no_commits {
        warn!(
            workspace_id = %workspace_id,
            task_id = %task.id,
            "Developer task ended with no new commits — marking failed"
        );
        WorkerTask::set_failed(pool, task.id, "El agente terminó sin crear commits nuevos").await?;
        archive_and_detach(db, container, workspace_id).await;
        return Ok(());
    }

    // Drain any declared agent actions (AGENT-ACTIONS-SPEC.md, F1) BEFORE
    // publishing the PR: a definitive failure here fails the task without ever
    // pushing a branch or opening a PR, so the human isn't left staring at a
    // PR whose side effects the agent could not produce.
    if !hook_agent_actions(config, db, workspace_id, task.id).await? {
        archive_and_detach(db, container, workspace_id).await;
        return Ok(());
    }

    // When the author worker has a personal PAT, push and PR creation use
    // *its* credentials so both operations show up under the worker's own
    // GitHub identity — that is the point of the per-worker PAT feature.
    let worker_pat = worker.github_pat.clone();
    // Remote-facing branch name: differs from the local branch only for
    // workspaces created from an existing PR (push maps local -> PR head).
    let remote_branch = Workspace::remote_branch_name(pool, workspace_id)
        .await
        .unwrap_or_else(|_| workspace.branch.clone());

    // Idempotency: if a PR is already recorded (fix-task workspaces are
    // linked to their PR at claim time; otherwise the agent created it via
    // gh cli and the pr_monitor already adopted it), push any local commits
    // best-effort and ensure the task is in_review. The push must not be
    // fatal here: agents are instructed to push themselves, and the PR head
    // may have moved (reviewer edits), which would reject this safety-net
    // push without invalidating the work already on the PR.
    match PullRequest::find_by_workspace_id(pool, workspace_id).await {
        Ok(prs) if !prs.is_empty() => {
            if let Err(e) = git.push_to_remote_with_token(
                &worktree_path,
                &workspace.branch,
                &remote_branch,
                false,
                worker_pat.as_deref(),
            ) {
                warn!(
                    workspace_id = %workspace_id,
                    task_id = %task.id,
                    "Best-effort push for already-recorded PR failed: {}",
                    e
                );
            }
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "PR already recorded for workspace — triggering on_pr_open"
            );
            return on_pr_open_and_push(db, container, workspace_id).await;
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "Could not query existing PRs: {}", e);
        }
        Ok(_) => {}
    }

    // Push the branch. A push failure is terminal for this run (no retry loop
    // per the spec); the human sees the cause on the card and can retry.
    if let Err(e) = git.push_to_remote_with_token(
        &worktree_path,
        &workspace.branch,
        &remote_branch,
        false,
        worker_pat.as_deref(),
    ) {
        error!(
            workspace_id = %workspace_id,
            task_id = %task.id,
            "Failed to push branch '{}': {}",
            workspace.branch,
            e
        );
        WorkerTask::set_failed(
            pool,
            task.id,
            &format!("Falló el push de '{}': {}", workspace.branch, e),
        )
        .await?;
        archive_and_detach(db, container, workspace_id).await;
        return Ok(());
    }
    info!(
        workspace_id = %workspace_id,
        task_id = %task.id,
        branch = %workspace.branch,
        "Branch pushed successfully"
    );

    // Resolve push remote and base branch.
    let push_remote = match git.resolve_remote_for_branch(&repo.path, &workspace.branch) {
        Ok(r) => r,
        Err(e) => {
            error!(workspace_id = %workspace_id, "Could not resolve remote: {}", e);
            WorkerTask::set_failed(
                pool,
                task.id,
                &format!("No se pudo resolver el remote: {e}"),
            )
            .await?;
            archive_and_detach(db, container, workspace_id).await;
            return Ok(());
        }
    };

    let target_branch_ref = &workspace_repo.target_branch;
    let (target_remote, base_branch) =
        match git.get_remote_from_branch_name(&repo.path, target_branch_ref) {
            Ok(remote) => {
                let branch = target_branch_ref
                    .strip_prefix(&format!("{}/", remote.name))
                    .unwrap_or(target_branch_ref);
                (remote, branch.to_string())
            }
            Err(_) => (push_remote.clone(), target_branch_ref.clone()),
        };

    let git_host = match GitHostService::from_url_with_token(&target_remote.url, worker_pat.clone())
    {
        Ok(h) => h,
        Err(GitHostError::UnsupportedProvider) => {
            error!(workspace_id = %workspace_id, "Unsupported git provider for URL '{}'", target_remote.url);
            WorkerTask::set_failed(
                pool,
                task.id,
                &format!("Proveedor git no soportado: {}", target_remote.url),
            )
            .await?;
            archive_and_detach(db, container, workspace_id).await;
            return Ok(());
        }
        Err(e) => {
            error!(workspace_id = %workspace_id, "Failed to create GitHostService: {}", e);
            WorkerTask::set_failed(
                pool,
                task.id,
                &format!("No se pudo crear el cliente del git host: {e}"),
            )
            .await?;
            archive_and_detach(db, container, workspace_id).await;
            return Ok(());
        }
    };

    // Adoption: check if the agent already created a PR via `gh pr create`.
    match git_host
        .list_prs_for_branch(&repo.path, &target_remote.url, &remote_branch)
        .await
    {
        Ok(prs) if !prs.is_empty() => {
            let pr = &prs[0];
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace_id,
                workspace_repo.repo_id,
                &base_branch,
                pr.number,
                &pr.url,
            )
            .await
            {
                warn!(workspace_id = %workspace_id, "Failed to record adopted PR locally: {}", e);
            }
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                pr_number = pr.number,
                "Adopted existing PR — triggering on_pr_open"
            );
            return on_pr_open_and_push(db, container, workspace_id).await;
        }
        Err(e) => {
            warn!(workspace_id = %workspace_id, "PR list check failed (proceeding to create): {}", e);
        }
        Ok(_) => {}
    }

    // Create the PR programmatically. Retry once on transient failures.
    let pr_body = build_pr_body(&task);
    let pr_request = CreatePrRequest {
        title: task.title.clone(),
        body: Some(pr_body),
        head_branch: remote_branch.clone(),
        base_branch: base_branch.clone(),
        draft: None,
        head_repo_url: Some(push_remote.url.clone()),
    };

    let pr_result = match git_host
        .create_pr(&repo.path, &target_remote.url, &pr_request)
        .await
    {
        Ok(info) => Ok(info),
        Err(first_err) => {
            warn!(
                workspace_id = %workspace_id,
                "First PR creation attempt failed ({}); retrying once",
                first_err
            );
            git_host
                .create_pr(&repo.path, &target_remote.url, &pr_request)
                .await
        }
    };

    match pr_result {
        Ok(pr_info) => {
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace_id,
                workspace_repo.repo_id,
                &base_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            {
                warn!(workspace_id = %workspace_id, "Failed to record new PR locally: {}", e);
            }
            info!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                pr_number = pr_info.number,
                "PR created — triggering on_pr_open"
            );
            // Territory lint (issue #95): best-effort, never fails the task.
            // Runs after the PR record is persisted so the comment lands on a
            // PR the reviewer already sees.
            audit_territory_and_comment(&git_host, &task, &pr_info.url).await;
            on_pr_open_and_push(db, container, workspace_id).await
        }
        Err(e) => {
            // "already exists" is a recoverable edge-case: adopt instead.
            if let GitHostError::PullRequest(ref msg) = e {
                if msg.to_ascii_lowercase().contains("already exists") {
                    if let Ok(prs) = git_host
                        .list_prs_for_branch(&repo.path, &target_remote.url, &remote_branch)
                        .await
                    {
                        if let Some(pr) = prs.into_iter().next() {
                            PullRequest::create_for_workspace(
                                pool,
                                workspace_id,
                                workspace_repo.repo_id,
                                &base_branch,
                                pr.number,
                                &pr.url,
                            )
                            .await
                            .ok();
                            info!(
                                workspace_id = %workspace_id,
                                task_id = %task.id,
                                pr_number = pr.number,
                                "PR already existed; adopted — triggering on_pr_open"
                            );
                            return on_pr_open_and_push(db, container, workspace_id).await;
                        }
                    }
                }
            }
            error!(
                workspace_id = %workspace_id,
                task_id = %task.id,
                "PR creation failed after retry: {}",
                e
            );
            WorkerTask::set_failed(pool, task.id, &format!("Falló la creación del PR: {e}"))
                .await?;
            archive_and_detach(db, container, workspace_id).await;
            Ok(())
        }
    }
}

/// Returns `true` when the current HEAD in `worktree_path` matches the
/// `before_head_commit` that was recorded when the latest CodingAgent
/// execution started — meaning the agent made no commits at all.
///
/// When the comparison cannot be performed (no execution record, no
/// before_head_commit, or git error), returns `false` so the caller does
/// not block a legitimate run on a best-effort check.
async fn check_no_new_commits(
    db: &DBService,
    git: &git::GitService,
    workspace_id: Uuid,
    worktree_path: &PathBuf,
) -> bool {
    let pool = &db.pool;

    let ep = match ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace_id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await
    {
        Ok(Some(ep)) => ep,
        _ => return false,
    };

    let repo_states =
        match ExecutionProcessRepoState::find_by_execution_process_id(pool, ep.id).await {
            Ok(s) => s,
            Err(_) => return false,
        };

    let Some(before_oid) = repo_states.into_iter().find_map(|s| s.before_head_commit) else {
        return false;
    };

    match git.get_head_info(worktree_path) {
        Ok(head) => head.oid == before_oid,
        Err(_) => false,
    }
}

/// Is this host error a 422 (Unprocessable Entity)? GitHub answers that
/// when an inline review comment doesn't land on the PR diff; the verdict
/// itself is fine, so the caller retries with the comments folded into the
/// review body instead of failing the round.
fn is_unprocessable_entity(e: &GitHostError) -> bool {
    let msg = e.to_string().to_ascii_lowercase();
    msg.contains("422") || msg.contains("unprocessable")
}

/// Build a PR body from a worker task: includes the task prompt and, when
/// an issue number is present, a "Closes #N" line.
fn build_pr_body(task: &WorkerTask) -> String {
    let mut body = task.prompt.trim().to_string();
    if let Some(issue) = task.issue_number {
        body.push_str(&format!("\n\nCloses #{issue}"));
    }
    body
}

/// Territory lint (issue #95).
///
/// If the developer's task declared a file territory in its issue body, fetch
/// the PR's changed files and post a warning comment listing anything that
/// falls outside the declared globs. Purely advisory — a lint failure never
/// blocks the workflow (the task is already in `in_review` by the time this
/// runs) and any error along the way is logged and swallowed.
///
/// Kept as a free function (not a method) so both PR-creation paths in
/// `on_developer_agent_finished` can call it without threading extra state.
async fn audit_territory_and_comment(git_host: &GitHostService, task: &WorkerTask, pr_url: &str) {
    let globs = task.territory_globs_parsed();
    if globs.is_empty() {
        return;
    }

    // Prefer the host's diff map — it's the source of truth for what GitHub
    // shows in the PR view. Missing (None) means the provider can't tell,
    // treat as "nothing to lint".
    let file_map = match git_host.get_pr_diff_line_map(pr_url).await {
        Ok(Some(map)) => map,
        Ok(None) => return,
        Err(e) => {
            warn!(
                task_id = %task.id,
                pr_url,
                "Territory lint: failed to fetch PR diff: {}",
                e
            );
            return;
        }
    };

    let mut files: Vec<String> = file_map.into_keys().collect();
    files.sort();
    let out_of_scope = territory::out_of_territory(&globs, &files);
    if out_of_scope.is_empty() {
        return;
    }

    let body = territory::territory_warning_body(&globs, &out_of_scope);
    match git_host.post_pr_comment(pr_url, &body).await {
        Ok(()) => info!(
            task_id = %task.id,
            pr_url,
            out_of_scope = out_of_scope.len(),
            "Territory lint: warning comment posted"
        ),
        Err(e) => warn!(
            task_id = %task.id,
            pr_url,
            "Territory lint: failed to post warning comment: {}",
            e
        ),
    }
}

/// Territory-lint text ready to append to a reviewer prompt. Looks up the
/// developer task for the PR via [`find_dev_task_for_pr`], re-computes
/// out-of-territory files against the current PR diff, and returns the same
/// body posted on the PR. `None` when the developer declared no territory,
/// the diff is unavailable, nothing is out of scope, or any lookup fails —
/// the injection is advisory, not a gate.
async fn territory_note_for_reviewer(
    git_host: &GitHostService,
    pool: &sqlx::SqlitePool,
    repo_id: Uuid,
    pr_number: i64,
    pr_url: &str,
) -> Option<String> {
    let dev_task = find_dev_task_for_pr(pool, repo_id, pr_number).await?;
    let globs = dev_task.territory_globs_parsed();
    if globs.is_empty() {
        return None;
    }

    let file_map = match git_host.get_pr_diff_line_map(pr_url).await {
        Ok(Some(map)) => map,
        _ => return None,
    };
    let mut files: Vec<String> = file_map.into_keys().collect();
    files.sort();
    let out_of_scope = territory::out_of_territory(&globs, &files);
    if out_of_scope.is_empty() {
        return None;
    }
    Some(territory::territory_warning_body(&globs, &out_of_scope))
}

/// Walk an LRU-ordered reviewer candidate list and pick the first one that
/// passes the dispatch-time guards:
///   (a) not the same worker as the PR author (self-review guard — GitHub
///       rejects `gh pr review --approve` from the PR author with 422), and
///   (b) strictly under [`WORKER_MAX_IN_REVIEW_ENV`] (capacity guard — same
///       cap that [`try_take_next`] enforces at start time; skipping saturated
///       reviewers here prevents the task from being enqueued on a worker that
///       already can't start it, which would starve the PR while other
///       reviewers sit idle).
///
/// Returns `Ok(None)` when every candidate fails at least one guard; the
/// caller logs and no-ops in that case.
pub(crate) async fn select_lru_reviewer(
    pool: &sqlx::SqlitePool,
    candidates: Vec<Worker>,
    author_worker_id: Option<Uuid>,
    cap: i64,
) -> Result<Option<Worker>, sqlx::Error> {
    // Two passes. LRU orders by last *assigned* task, which says nothing
    // about availability: a reviewer can be LRU-first while its agent is
    // mid-review, and the in_review cap below can't see that — reviewer
    // tasks go queued → in_progress → done without ever holding an
    // `in_review` slot. First pass takes only reviewers that are free right
    // now; second pass (everyone busy) falls back to queueing on the
    // LRU-first eligible reviewer so the task still lands somewhere.
    for busy_allowed in [false, true] {
        for candidate in &candidates {
            if let Some(author_id) = author_worker_id {
                if candidate.id == author_id {
                    continue;
                }
            }
            let in_review = WorkerTask::count_in_review(pool, candidate.id).await?;
            if in_review >= cap {
                debug!(
                    reviewer_id = %candidate.id,
                    in_review,
                    cap,
                    "Skipping LRU-first reviewer at WORKER_MAX_IN_REVIEW cap; \
                     trying next candidate"
                );
                continue;
            }
            if !busy_allowed {
                let active = WorkerTask::count_active(pool, candidate.id).await?;
                if active > 0 {
                    debug!(
                        reviewer_id = %candidate.id,
                        active,
                        "Skipping busy reviewer (queued/in_progress task); \
                         trying next candidate"
                    );
                    continue;
                }
            }
            return Ok(Some(candidate.clone()));
        }
    }
    Ok(None)
}

/// Dispatch a review task to the next available reviewer worker for the given
/// PR.
///
/// Reviewer selection is least-recently-assigned first: with N active
/// reviewer workers the dispatcher rotates through them by picking the one
/// whose most recent `worker_task` is oldest (or who has never taken a task
/// at all). See [`Worker::list_active_reviewers_lru`] for the exact ordering.
/// With a single reviewer the behavior is unchanged from the old
/// `find_first_reviewer`-based dispatch: the same reviewer is picked every
/// time.
///
/// The LRU walk (see [`select_lru_reviewer`]) skips candidates that are the
/// PR author or already at the `WORKER_MAX_IN_REVIEW` cap, so a saturated
/// reviewer never gets a fresh task enqueued while another reviewer has
/// capacity — the exact starvation issue #302 asks us to eliminate. It also
/// prefers reviewers with no queued/in-progress task over ones whose agent
/// is running right now, falling back to the busy LRU-first reviewer's
/// queue only when every candidate is occupied.
///
/// No-op (with debug/warn logging) when:
/// - `WORKER_LEAD_ENABLED=false`
/// - No reviewer worker is registered
/// - Every active reviewer is the PR author or is at the
///   `WORKER_MAX_IN_REVIEW` cap
/// - An active reviewer task already exists for this PR (idempotent guard)
/// - The PR has already reached the `Config.max_review_rounds` cap (escalated;
///   the `WORKER_REVIEW_MAX_ROUNDS` env var may still override the Config)
/// - A recent infrastructure failure put the PR inside its retry backoff
///   window (skipped when `manual` — an explicit human retry overrides the
///   automatic throttle)
pub async fn dispatch_review_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    pr_title: &str,
    repo_id: Uuid,
    author_worker_id: Option<Uuid>,
    manual: bool,
) -> Result<(), sqlx::Error> {
    if !lead_enabled_from_env() {
        return Ok(());
    }

    let pool = &db.pool;

    let candidates = Worker::list_active_reviewers_lru(pool).await?;
    if candidates.is_empty() {
        debug!(
            pr_number,
            "No reviewer worker found — skipping review dispatch"
        );
        return Ok(());
    }

    let cap = max_in_review_from_env();
    let reviewer = select_lru_reviewer(pool, candidates, author_worker_id, cap).await?;

    let Some(reviewer) = reviewer else {
        debug!(
            pr_number,
            author_worker_id = ?author_worker_id,
            cap,
            "No eligible reviewer for PR #{} — every active reviewer is \
             either the PR author or already at the WORKER_MAX_IN_REVIEW cap. \
             Skipping dispatch.",
            pr_number,
        );
        return Ok(());
    };

    // Identity guard at the GitHub-account level. Distinct workers can still
    // share one GitHub identity (no PAT → both act as the machine's global
    // gh account), and GitHub rejects actionable reviews from the PR
    // author's account — the review silently degrades to COMMENTED and the
    // loop burns rounds without ever producing a verdict. Block dispatch
    // instead and tell the operator what to fix.
    if reviewer.github_pat.is_none() {
        warn!(
            reviewer_id = %reviewer.id,
            pr_number,
            "Reviewer worker has no GitHub PAT — it would review as the \
             machine's global account (usually the PR author), which GitHub \
             caps at COMMENTED. Skipping dispatch; configure a PAT from a \
             distinct GitHub account on the reviewer worker."
        );
        return Ok(());
    }
    let author_login = match author_worker_id {
        Some(id) => Worker::find_by_id(pool, id)
            .await?
            .and_then(|w| w.github_login),
        None => None,
    };
    // Fall back to the global gh account: a developer without its own PAT
    // pushes and opens PRs as that identity.
    let author_login = match author_login {
        Some(login) => Some(login),
        None => config.read().await.github.username.clone(),
    };
    if let (Some(reviewer_login), Some(author_login)) =
        (reviewer.github_login.as_deref(), author_login.as_deref())
    {
        if reviewer_login.eq_ignore_ascii_case(author_login) {
            warn!(
                reviewer_id = %reviewer.id,
                reviewer_login,
                pr_number,
                "Reviewer's GitHub account matches the PR author's — GitHub \
                 rejects self-approval. Skipping dispatch; use a PAT from a \
                 different account on the reviewer worker."
            );
            return Ok(());
        }
    }

    if WorkerTask::find_active_reviewer_task_for_pr(pool, pr_number, repo_id)
        .await?
        .is_some()
    {
        debug!(
            pr_number,
            "Active reviewer task already exists for PR — skipping duplicate dispatch"
        );
        return Ok(());
    }

    let max_rounds = {
        let cfg = config.read().await;
        resolve_max_review_rounds(&cfg)
    };
    // Cap is enforced against the ledger of submitted rounds (spec §A5).
    // Failed rounds (invalid JSON, infra error, agent crash) don't count —
    // only rounds that actually produced a verdict on GitHub burn budget.
    let rounds = ReviewRound::count_submitted_for_pr(pool, repo_id, pr_number).await?;
    if rounds >= max_rounds {
        warn!(
            pr_number,
            rounds,
            max_rounds,
            "PR #{} has reached the maximum review rounds ({}/{}) — escalated, human review required",
            pr_number,
            rounds,
            max_rounds,
        );
        return Ok(());
    }

    // Infrastructure-failure gate: previous dispatches for this PR whose
    // agent never really ran (API error) don't count as rounds, but they do
    // throttle the next attempt — exponential backoff instead of one doomed
    // dispatch per monitor poll, and a hard stop after too many in a row.
    let trailing_infra =
        WorkerTask::count_trailing_infra_failures_for_pr(pool, pr_number, repo_id).await?;
    if trailing_infra > 0 && !manual {
        if trailing_infra >= MAX_INFRA_RETRIES_PER_PR {
            warn!(
                pr_number,
                trailing_infra,
                "Review dispatch for PR #{} suspended after {} consecutive \
                 infrastructure failures — fix the API/model configuration \
                 and relaunch the review manually",
                pr_number,
                trailing_infra,
            );
            return Ok(());
        }
        if let Some(last_failure) =
            WorkerTask::last_infra_failure_at_for_pr(pool, pr_number, repo_id).await?
        {
            let backoff = infra_retry_backoff(trailing_infra);
            if chrono::Utc::now() - last_failure < backoff {
                debug!(
                    pr_number,
                    trailing_infra,
                    backoff_minutes = backoff.num_minutes(),
                    "Waiting out infra-failure backoff before redispatching review"
                );
                return Ok(());
            }
        }
        info!(
            pr_number,
            trailing_infra, "Retrying review dispatch after infrastructure failure(s)"
        );
    }

    // Pin the head SHA at dispatch time. The server submits the review
    // against THIS commit even if the author pushes further work while the
    // reviewer is running — the verdict is a statement about a specific
    // commit, not a moving target. Without a known PR record we can't resolve
    // the SHA, so we bail: dispatching a review against "unknown" would
    // strand the round because the eventual submission has no `commit_id`.
    let pr_record = match PullRequest::find_by_repo_and_number(pool, repo_id, pr_number).await? {
        Some(pr) => pr,
        None => {
            warn!(
                pr_number,
                repo_id = %repo_id,
                "No local PullRequest record for PR — cannot pin head SHA. \
                 Skipping review dispatch until pr_monitor records the PR."
            );
            return Ok(());
        }
    };
    let git_host =
        match GitHostService::from_url_with_token(&pr_record.pr_url, reviewer.github_pat.clone()) {
            Ok(gh) => gh,
            Err(e) => {
                warn!(
                    pr_number,
                    "Cannot construct git host for PR — skipping review dispatch: {}", e
                );
                return Ok(());
            }
        };
    let head_sha = match git_host.get_pr_head_sha(&pr_record.pr_url).await {
        Ok(Some(sha)) if !sha.is_empty() => sha,
        Ok(_) => {
            warn!(
                pr_number,
                "GitHub returned no head SHA for PR — skipping dispatch this cycle"
            );
            return Ok(());
        }
        Err(e) => {
            warn!(
                pr_number,
                "Failed to resolve head SHA before dispatch — retrying next cycle: {}", e
            );
            return Ok(());
        }
    };

    let task_title = format!("Review PR #{}: {}", pr_number, pr_title);
    let mut task_prompt = quick_action_prompts::format_review_pr_prompt(pr_number, &head_sha);

    // Territory lint injection (issue #95, filosofía #368). If the developer
    // task declared a `## Territorio` and the current PR diff strays outside
    // it, append the same warning that lands as a PR comment to the reviewer
    // prompt so the checklist doesn't require the reviewer to re-derive
    // territory from the issue by hand. Best-effort: any failure is logged
    // and the reviewer prompt goes out unchanged.
    if let Some(territory_note) =
        territory_note_for_reviewer(&git_host, pool, repo_id, pr_number, &pr_record.pr_url).await
    {
        task_prompt.push_str("\n\n");
        task_prompt.push_str(&territory_note);
    }

    let task = WorkerTask::append(
        pool,
        reviewer.id,
        &CreateWorkerTask {
            repo_id,
            title: task_title,
            prompt: task_prompt,
            issue_number: Some(pr_number),
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        },
    )
    .await?;

    // Ledger row for the round: `pending` until the reviewer finishes and the
    // server submits (or fails, or is superseded). This is the source of
    // truth for round accounting (cap, idempotency, "latest verdict") — the
    // old `count_reviewer_tasks_for_pr` heuristic is dead once every dispatch
    // writes here.
    if let Err(e) = ReviewRound::create(
        pool,
        &CreateReviewRound {
            repo_id,
            pr_number,
            kind: review_round::KIND_REVIEW.to_string(),
            head_sha: head_sha.clone(),
            base_sha: None,
            task_id: Some(task.id),
            reasons: None,
        },
    )
    .await
    {
        warn!(
            pr_number,
            task_id = %task.id,
            "Failed to insert review_rounds row at dispatch: {}",
            e
        );
    }

    // After repeated infra failures, pin a known-good model on the retry —
    // in practice the premium model is what gets gated first (e.g. `fable`
    // returning 404 while opus workers keep running).
    if trailing_infra >= INFRA_MODEL_FALLBACK_THRESHOLD
        && reviewer.model.as_deref() != Some(INFRA_FALLBACK_MODEL)
    {
        WorkerTask::set_model_override(pool, task.id, INFRA_FALLBACK_MODEL).await?;
        warn!(
            reviewer_id = %reviewer.id,
            pr_number,
            task_id = %task.id,
            trailing_infra,
            "Degrading review to model '{}' after repeated infrastructure failures",
            INFRA_FALLBACK_MODEL,
        );
    }

    info!(
        reviewer_id = %reviewer.id,
        pr_number,
        task_id = %task.id,
        round = rounds + 1,
        "Dispatched review task for PR #{} (round {}/{})",
        pr_number,
        rounds + 1,
        max_rounds,
    );

    match try_take_next(config, db, container, reviewer.id).await {
        Ok(_) => info!(reviewer_id = %reviewer.id, "Reviewer worker started on review task"),
        Err(e) if e.is_conflict() => {}
        Err(StartError::Sqlx(e)) => return Err(e),
        Err(e) => warn!(
            reviewer_id = %reviewer.id,
            "Failed to auto-start reviewer after dispatch: {}",
            e
        ),
    }

    Ok(())
}

/// Delete queued review/fix tasks referencing a PR that was merged or closed —
/// reviewing or fixing it no longer makes sense. In-progress tasks are left
/// alone; their runs finish on their own.
pub async fn cancel_stale_pr_tasks(
    db: &DBService,
    pr_number: i64,
    repo_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let removed = WorkerTask::delete_queued_tasks_for_pr(&db.pool, pr_number, repo_id).await?;
    if removed > 0 {
        info!(
            pr_number,
            removed, "Removed {} stale queued task(s) for finished PR #{}", removed, pr_number,
        );
    }
    Ok(removed)
}

/// Cancel reviewer tasks stranded on PRs that already merged or closed.
///
/// Symmetric to `WorkerTask::complete_review_fix_tasks_for_merged_prs`, but
/// for the reviewer role: a reviewer's workspace is not the PR's primary
/// workspace, so `on_pr_merged` never touches it. Without this sweep the
/// reviewer keeps polling GitHub for a PR that will never accept its review
/// (GitHub rejects reviews on merged/closed PRs), and its whole queue sits
/// behind the doomed run for as long as the agent keeps retrying.
///
/// Per-task handling mirrors `cancel_worker_task`:
/// - `queued` → deleted (it never ran; nothing to preserve).
/// - `in_progress` / `in_review` → workspace stopped and archived, task
///   marked `done` (keeps the audit trail like the review-fix sweep does),
///   any pending `review_rounds` row marked `superseded`.
///
/// Freed workers are offered their next queued task via `try_take_next`.
/// Runs on every pr_monitor poll: idempotent — after the first pass there
/// is nothing left to find.
pub async fn cancel_orphan_reviewer_tasks_for_finished_prs(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let rows = WorkerTask::find_reviewer_tasks_for_finished_prs(pool).await?;
    if rows.is_empty() {
        return Ok(());
    }

    let mut freed: Vec<Uuid> = Vec::new();
    for (task_id, worker_id, workspace_id, status) in rows {
        info!(
            task_id = %task_id,
            worker_id = %worker_id,
            status = %status,
            "Cancelling reviewer task: its PR is already merged/closed",
        );

        if status == worker_task::STATUS_QUEUED {
            if let Err(e) = WorkerTask::delete(pool, task_id).await {
                warn!(
                    task_id = %task_id,
                    "Failed to delete queued reviewer task: {}", e
                );
                continue;
            }
        } else {
            if let Some(ws_id) = workspace_id {
                if let Ok(Some(workspace)) = Workspace::find_by_id(pool, ws_id).await {
                    container.try_stop(&workspace, false).await;
                }
                archive_and_detach(db, container, ws_id).await;
            }
            if let Err(e) = WorkerTask::set_status(pool, task_id, worker_task::STATUS_DONE).await {
                warn!(
                    task_id = %task_id,
                    "Failed to mark cancelled reviewer task done: {}", e
                );
                continue;
            }
            // The round will never produce a verdict — mark it superseded
            // so accounting stays honest (superseded rounds don't burn the
            // per-PR budget, unlike submitted ones).
            match ReviewRound::find_by_task_id(pool, task_id).await {
                Ok(Some(round)) if round.status == review_round::STATUS_PENDING => {
                    if let Err(e) =
                        ReviewRound::set_status(pool, round.id, review_round::STATUS_SUPERSEDED)
                            .await
                    {
                        warn!(
                            round_id = %round.id,
                            "Failed to mark orphan review round superseded: {}", e
                        );
                    }
                }
                Ok(_) => {}
                Err(e) => warn!(
                    task_id = %task_id,
                    "Failed to look up review round for cancelled reviewer task: {}", e
                ),
            }
        }

        if !freed.contains(&worker_id) {
            freed.push(worker_id);
        }
    }

    for worker_id in freed {
        match try_take_next(config, db, container, worker_id).await {
            Ok(_) => info!(
                worker_id = %worker_id,
                "Worker took next task after reviewer-orphan cleanup",
            ),
            Err(e) if e.is_conflict() => {}
            Err(e) => warn!(
                worker_id = %worker_id,
                "Failed to start next task after reviewer-orphan cleanup: {}", e
            ),
        }
    }

    Ok(())
}

/// Safety net for stuck queues: any active worker with queued tasks and
/// nothing in progress gets nudged into `try_take_next`.
///
/// Every finish path (`on_pr_merged`, `on_agent_finished`, post-dispatch,
/// `cancel_worker_task`, the review-fix and reviewer-orphan sweeps) is
/// supposed to call `try_take_next` on the freed worker. If any of them
/// regresses — or a new code path forgets to — the queue would drain only
/// when a lucky external event (a new PR, a manual Start) happens to fire
/// the trigger. This sweep reconciles that on every poll instead of
/// trusting event-driven triggers, same principle as the review-fix sweep
/// added in #387.
///
/// `try_take_next` is idempotent and already enforces the in-review cap,
/// license gate, and workspace auto-repair, so a worker that is legitimately
/// idle (nothing queued, cap reached, license suspended) just returns a
/// conflict, which is swallowed.
pub async fn kickstart_stuck_worker_queues(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let workers = Worker::list_all(pool).await?;

    for worker in workers {
        if WorkerTask::find_in_progress(pool, worker.id)
            .await?
            .is_some()
        {
            continue;
        }
        if WorkerTask::find_next_queued(pool, worker.id)
            .await?
            .is_none()
        {
            continue;
        }

        match try_take_next(config, db, container, worker.id).await {
            Ok(started) => info!(
                worker_id = %worker.id,
                task_id = %started.task.id,
                "Kickstarted stuck worker queue: took next queued task"
            ),
            Err(e) if e.is_conflict() => {}
            Err(e) => warn!(
                worker_id = %worker.id,
                "Failed to kickstart stuck worker queue: {}", e
            ),
        }
    }

    Ok(())
}

/// Cancel any other pending reviewer rounds pinned to the same PR head as
/// the one that just submitted. In steady state the dispatch guard
/// (`find_active_reviewer_task_for_pr`) prevents two active reviewer tasks
/// on the same PR, so this normally finds nothing — it's a safety net for
/// the rare race where two dispatches slip past the guard (or a manual
/// dispatch collides with the automatic one). Same per-task handling as
/// the merged-PR sweep: queued deleted, in-flight stopped + task closed +
/// worker offered its next task; the redundant round row is marked
/// `superseded` (its verdict is redundant because GitHub already has one
/// for this exact commit).
pub async fn cancel_sibling_reviewer_rounds_for_head(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    repo_id: Uuid,
    pr_number: i64,
    head_sha: &str,
    exclude_round_id: Uuid,
) -> Result<(), sqlx::Error> {
    let pool = &db.pool;
    let siblings = ReviewRound::find_other_pending_for_head(
        pool,
        repo_id,
        pr_number,
        head_sha,
        exclude_round_id,
    )
    .await?;
    if siblings.is_empty() {
        return Ok(());
    }

    for sibling in siblings {
        warn!(
            round_id = %sibling.id,
            pr_number,
            head_sha,
            "Superseding sibling reviewer round: another verdict already submitted for this head",
        );

        if let Some(task_id) = sibling.task_id
            && let Some(task) = WorkerTask::find_by_id(pool, task_id).await?
        {
            match task.status.as_str() {
                worker_task::STATUS_QUEUED => {
                    if let Err(e) = WorkerTask::delete(pool, task_id).await {
                        warn!(
                            task_id = %task_id,
                            "Failed to delete sibling reviewer task: {}", e
                        );
                    }
                }
                worker_task::STATUS_IN_PROGRESS | worker_task::STATUS_IN_REVIEW => {
                    if let Some(ws_id) = task.workspace_id {
                        if let Ok(Some(workspace)) = Workspace::find_by_id(pool, ws_id).await {
                            container.try_stop(&workspace, false).await;
                        }
                        archive_and_detach(db, container, ws_id).await;
                    }
                    if let Err(e) =
                        WorkerTask::set_status(pool, task_id, worker_task::STATUS_DONE).await
                    {
                        warn!(
                            task_id = %task_id,
                            "Failed to mark sibling reviewer task done: {}", e
                        );
                    }
                    match try_take_next(config, db, container, task.worker_id).await {
                        Ok(_) => {}
                        Err(e) if e.is_conflict() => {}
                        Err(e) => warn!(
                            worker_id = %task.worker_id,
                            "Failed to start next task after sibling cancellation: {}", e
                        ),
                    }
                }
                _ => {}
            }
        }

        if let Err(e) =
            ReviewRound::set_status(pool, sibling.id, review_round::STATUS_SUPERSEDED).await
        {
            warn!(
                round_id = %sibling.id,
                "Failed to mark sibling review round superseded: {}", e
            );
        }
    }

    Ok(())
}

/// Resolved context for the remediation prompt.
///
/// `pr_url` is always populated (falls back to the empty string only when the
/// PR record itself is missing, so the prompt still renders). `owner_repo`
/// is `Some(slug)` only when the URL is a recognizable GitHub PR URL — the
/// prompt uses that to switch between `-R owner/repo` and positional-URL
/// `gh` invocations so we never emit `-R <full-url>` (see PR #490 review).
struct RemediationContext {
    pr_url: String,
    owner_repo: Option<String>,
    comments_block: Option<String>,
}

impl RemediationContext {
    fn empty(pr_number: i64) -> Self {
        // Last-resort fallback when even the PR record is gone. We synthesize
        // a `PR #<n>` string so the prompt still identifies the PR to the
        // agent; owner_repo stays None so `-R` is skipped.
        Self {
            pr_url: format!("PR #{pr_number}"),
            owner_repo: None,
            comments_block: None,
        }
    }
}

/// Best-effort enrichment for the remediation prompt: resolve the PR URL and
/// `owner/repo` slug from the PR record and pull the reviewer's comments
/// (general + inline) so they can be dropped inline instead of asking the
/// agent to shell out. Never blocks dispatch: any lookup/network failure
/// logs a warn and the caller falls back to the pre-issue-368 behaviour
/// (agent runs `gh pr view --comments`).
async fn collect_pr_comments_context(
    db: &DBService,
    pr_number: i64,
    repo_id: Uuid,
) -> RemediationContext {
    let pool = &db.pool;

    // Resolve the PR record so we get the URL for owner/repo parsing.
    let pr = match PullRequest::find_by_repo_and_number(pool, repo_id, pr_number).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            warn!(
                pr_number,
                "PR record missing — remediation prompt will use fallback"
            );
            return RemediationContext::empty(pr_number);
        }
        Err(e) => {
            warn!(
                pr_number,
                "Failed to load PR for remediation enrichment: {e}"
            );
            return RemediationContext::empty(pr_number);
        }
    };

    let owner_repo = quick_action_prompts::parse_owner_repo_from_pr_url(&pr.pr_url);
    let mut ctx = RemediationContext {
        pr_url: pr.pr_url.clone(),
        owner_repo,
        comments_block: None,
    };

    // Resolve the repo path + remote so `GitHostService` can fetch comments.
    let repo = match Repo::find_by_id(pool, repo_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            warn!(pr_number, "Repo missing for remediation enrichment");
            return ctx;
        }
        Err(e) => {
            warn!(
                pr_number,
                "Failed to load repo for remediation enrichment: {e}"
            );
            return ctx;
        }
    };

    // Repos have `default_target_branch` from setup; if it's missing, fall
    // back to the PR's target branch as recorded on the row.
    let target_branch = repo
        .default_target_branch
        .clone()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| pr.target_branch_name.clone());
    let repo_path = repo.path.clone();

    // Remote resolution + host construction + comments fetch all shell out;
    // wrap each in the same log-and-fallback shape.
    let git = git::GitService::new();
    let remote = match git.resolve_remote_for_branch(&repo_path, &target_branch) {
        Ok(r) => r,
        Err(e) => {
            warn!(
                pr_number,
                "Failed to resolve remote for remediation enrichment: {e}"
            );
            return ctx;
        }
    };
    let host = match GitHostService::from_url(&remote.url) {
        Ok(h) => h,
        Err(e) => {
            warn!(
                pr_number,
                "Unsupported host for remediation enrichment: {e}"
            );
            return ctx;
        }
    };
    let comments = match host
        .get_pr_comments(&repo_path, &remote.url, pr_number)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!(
                pr_number,
                "Failed to fetch PR comments for remediation enrichment: {e}"
            );
            return ctx;
        }
    };

    ctx.comments_block = quick_action_prompts::render_comments_block(
        &comments,
        quick_action_prompts::COMMENTS_BLOCK_MAX_BYTES,
    );
    ctx
}

/// Text of the remediation prompt sent to the author when a reviewer
/// requests changes on their PR. Shared between the primary follow-up path
/// (dispatched on the original task's live workspace, issue #473) and the
/// fallback review_fix task path (used only when the original workspace is
/// gone).
///
/// The prompt is intentionally free of git plumbing (no fetch, no
/// reset --hard, no explicit push refspec): the system already positions
/// the worktree on the PR head at start time (issue #366, via
/// `LocalContainerService::create` → `WorkspaceManager::create_workspace`
/// with a pinned `starting_point`), and the finish handler pushes the local
/// branch back to the PR's `remote_branch` (`on_developer_agent_finished`
/// in this module). The agent just needs to read the review, fix the
/// issues, and commit.
///
/// `owner_repo` is the pre-resolved `owner/name` slug when the PR URL is a
/// recognizable GitHub URL. When `None` (Azure DevOps, malformed URL, etc.)
/// the prompt falls back to invoking `gh` positionally with the PR URL so we
/// never emit a broken `-R <full-url>` flag (see PR #490 review). `pr_url`
/// is always passed through — it's the stable identifier the fallback uses.
/// `comments_block` is the pre-rendered inline text of the review comments
/// (issue #368); when `Some`, the agent reads them directly from the prompt
/// with no `gh` call at all. Pass `None` when the enrichment fetch failed
/// and the agent should fall back to `gh` to fetch them itself.
fn build_remediation_prompt(
    pr_number: i64,
    pr_url: &str,
    owner_repo: Option<&str>,
    comments_block: Option<&str>,
) -> String {
    let comments_section = match comments_block {
        Some(block) => format!(
            "Los comentarios del reviewer están abajo (generales + inline con archivo/línea). \
             Leélos tal como vienen — no hace falta volver a consultarlos con `gh`.\n\n{block}\n\n"
        ),
        None => match owner_repo {
            Some(slug) => format!(
                "Revisá los comentarios del reviewer con \
                 `gh pr view {pr_number} -R {slug} --comments` y los inline con \
                 `gh api repos/{slug}/pulls/{pr_number}/comments`.\n\n"
            ),
            None => format!(
                "Revisá los comentarios del reviewer con `gh pr view {pr_url} --comments`; \
                 para los inline, resolvé el path de la API a partir del URL del PR.\n\n"
            ),
        },
    };
    let pr_header = match owner_repo {
        Some(slug) => format!("PR #{pr_number} ({slug})"),
        None => format!("PR #{pr_number} ({pr_url})"),
    };
    format!(
        "El reviewer solicitó cambios en el {pr_header}. \
         Tu worktree ya está posicionado sobre el head del PR — no hace \
         falta hacer fetch, checkout, ni reset.\n\n\
         {comments_section}\
         Corregí los issues señalados y commiteá. \
         El sistema pushea tus commits a la rama del PR al finalizar la \
         corrida: no pushees a mano ni crees un PR nuevo — el PR ya existe."
    )
}

/// Try to dispatch the remediation prompt as a CodingAgent follow-up on the
/// author's original `in_review` task workspace. This is the primary path per
/// issue #473: one ticket = one card that transitions states, driven by
/// activity in the developer task's own workspace — no separate `review_fix`
/// task, no duplicate sidebar entry.
///
/// Returns `Ok(true)` when the follow-up was dispatched (or is already in
/// flight, per idempotency). Returns `Ok(false)` when the workspace can't
/// receive a follow-up (missing, archived, worktree gone, no resumable
/// session, mismatched executor) — the caller falls back to the legacy
/// `review_fix` task path so remediation still lands.
///
/// The developer task's status stays `in_review` throughout: the
/// `on_developer_agent_finished` handler already treats a run that ends while
/// the task is `in_review` as a follow-up (push commits, do not archive, do
/// not touch state) — the review re-dispatch then flows through the normal
/// `pr_monitor` head-moved check.
async fn dispatch_remediation_follow_up(
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    repo_id: Uuid,
    author_worker_id: Uuid,
    prompt: &str,
) -> Result<bool, sqlx::Error> {
    let pool = &db.pool;

    // The PR's primary workspace is the developer's original workspace (the
    // PR was created from it). Note that a developer task's `issue_number`
    // usually references the GitHub issue being addressed, not the PR number,
    // so looking up the dev task by `issue_number == pr_number` would miss
    // the common case — we resolve via the PR ↔ workspace linkage instead.
    let Some(workspace_id) =
        PullRequest::find_latest_workspace_for_pr(pool, repo_id, pr_number).await?
    else {
        return Ok(false);
    };

    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        return Ok(false);
    };
    if workspace.archived || workspace.worktree_deleted {
        return Ok(false);
    }

    let Some(dev_task) = WorkerTask::find_by_workspace(pool, workspace_id).await? else {
        return Ok(false);
    };
    // Skip if the workspace's task isn't the developer's in_review task: it
    // may be a legacy review_fix task's workspace still linked to the PR (on
    // a fleet that hasn't drained pre-#473 fix tasks), or the dev task may be
    // in_progress / terminal. In every case, fall back to the caller's
    // legacy path.
    if dev_task.worker_id != author_worker_id
        || dev_task.status != worker_task::STATUS_IN_REVIEW
        || WorkerTask::kind(pool, dev_task.id).await?.as_deref()
            == Some(worker_task::KIND_REVIEW_FIX)
    {
        return Ok(false);
    }

    // Idempotency: if a coding-agent run is already live on this workspace,
    // remediation is already in flight (or a manual follow-up is running) —
    // nothing more to dispatch. Report success so the caller does not fall
    // back to creating a duplicate review_fix task.
    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
        .await
        .unwrap_or(false)
    {
        debug!(
            pr_number,
            workspace_id = %workspace_id,
            "A coding-agent run is already live on the workspace — remediation is already in flight"
        );
        return Ok(true);
    }

    let Some(session) = Session::find_latest_by_workspace_id(pool, workspace_id).await? else {
        return Ok(false);
    };

    // Take the executor config from the most recent CodingAgent process on
    // this session. The follow-up's `session_id` is opaque to the executor
    // CLI, so it has to match the executor that originally issued it; reusing
    // the same config is the simplest way to guarantee that.
    let Some(latest_process) = ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace_id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await?
    else {
        return Ok(false);
    };
    let executor_config = match latest_process.executor_action() {
        Ok(action) => match &action.typ {
            ExecutorActionType::CodingAgentInitialRequest(req) => req.executor_config.clone(),
            ExecutorActionType::CodingAgentFollowUpRequest(req) => req.executor_config.clone(),
            _ => return Ok(false),
        },
        Err(_) => return Ok(false),
    };

    let Some(session_info) = CodingAgentTurn::find_latest_session_info_for_executor(
        pool,
        session.id,
        &executor_config.executor.to_string(),
    )
    .await?
    else {
        return Ok(false);
    };

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    let action = ExecutorAction::new(
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: prompt.to_string(),
            session_id: session_info.session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        }),
        None,
    );

    // Deliberately do NOT clear `review_result` here: while the follow-up
    // runs, `compute_loop_state` uses "review_result=changes_requested AND
    // developer_agent_running" as its signal for the `fixing` badge (the
    // remediation now runs on the developer's workspace, not on a separate
    // `review_fix` task, so the old fix-task activity signal is absent).
    // The next reviewer round overwrites `review_result` with the fresh
    // verdict via `pr_monitor` when the new head is reviewed.

    match container
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await
    {
        Ok(process) => {
            info!(
                author_worker_id = %author_worker_id,
                author_task_id = %dev_task.id,
                workspace_id = %workspace_id,
                session_id = %session.id,
                execution_process_id = %process.id,
                pr_number,
                "Remediation dispatched as follow-up on the author's original task"
            );
            Ok(true)
        }
        Err(e) => {
            warn!(
                pr_number,
                workspace_id = %workspace_id,
                "Failed to start remediation follow-up on original workspace: {}",
                e
            );
            Ok(false)
        }
    }
}

/// Dispatch a fix task to the PR author worker when a reviewer requests changes.
///
/// Primary path (issue #473): dispatch the remediation prompt as a
/// CodingAgent follow-up on the author's ORIGINAL `in_review` task workspace,
/// so a single card transitions its own review state — no duplicate "Atendé
/// el review" sidebar entry per round.
///
/// Fallback: when the original workspace is gone (archived, worktree lost,
/// missing session), fall back to the legacy `review_fix` task path. The
/// fresh workspace is materialized already on the PR head (issue #366) and
/// the finish handler pushes back to the PR's `remote_branch`, so the
/// prompt itself carries no git plumbing.
///
/// No-op when:
/// - `WORKER_LEAD_ENABLED=false`
/// - No review round has actually completed yet
/// - A remediation is already in flight for this PR (idempotent guard on
///   both the follow-up path and the fallback task path)
pub async fn dispatch_author_fix_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    repo_id: Uuid,
    author_worker_id: Uuid,
) -> Result<(), sqlx::Error> {
    if !lead_enabled_from_env() {
        return Ok(());
    }

    let pool = &db.pool;

    // Sanity guard: a fix only makes sense after at least one review round
    // actually completed.
    let completed_reviews =
        WorkerTask::count_reviewer_tasks_done_for_pr(pool, pr_number, repo_id).await?;
    if completed_reviews == 0 {
        debug!(
            pr_number,
            "No completed reviewer task yet — skipping fix dispatch"
        );
        return Ok(());
    }

    // Idempotency guard for the legacy path: while a queued/in_progress
    // `review_fix` task exists (from a prior dispatch that took the fallback
    // path, or from a fleet still draining old fix-tasks), do not queue a
    // second one. The follow-up path has its own idempotency via
    // `has_running_non_dev_server_processes_for_workspace`.
    if let Some(pending) =
        WorkerTask::find_pending_review_fix_for_pr(pool, pr_number, repo_id).await?
    {
        debug!(
            pr_number,
            pending_task_id = %pending.id,
            "A review-fix task for this PR is already pending — skipping duplicate dispatch"
        );
        return Ok(());
    }

    // Enrich the prompt with the reviewer's comments + a resolved owner/repo
    // slug so the agent doesn't have to shell out to `gh pr view --comments`
    // (and never sees a `{{owner}}/{{repo}}` placeholder). Any failure logs
    // a warn and drops us into the fallback prompt — enrichment is optional,
    // never a dispatch blocker.
    let ctx = collect_pr_comments_context(db, pr_number, repo_id).await;

    let task_prompt = build_remediation_prompt(
        pr_number,
        &ctx.pr_url,
        ctx.owner_repo.as_deref(),
        ctx.comments_block.as_deref(),
    );

    // Primary path (#473): dispatch as a system follow-up on the author's
    // ORIGINAL in_review task workspace. One card = one PR, transitioning
    // states in place — no duplicate "Atendé el review" entry.
    match dispatch_remediation_follow_up(
        db,
        container,
        pr_number,
        repo_id,
        author_worker_id,
        &task_prompt,
    )
    .await
    {
        Ok(true) => {
            info!(
                author_worker_id = %author_worker_id,
                pr_number,
                completed_reviews,
                "Author fix dispatched as follow-up on the original task workspace"
            );
            return Ok(());
        }
        Ok(false) => {
            info!(
                author_worker_id = %author_worker_id,
                pr_number,
                "Original workspace unavailable for follow-up — falling back to review_fix task"
            );
        }
        Err(e) => {
            warn!(
                author_worker_id = %author_worker_id,
                pr_number,
                "Follow-up remediation dispatch failed — falling back to review_fix task: {}",
                e
            );
        }
    }

    // Fallback: original workspace is gone. Create a `review_fix` task; the
    // orchestrator materializes its fresh workspace on the PR head (issue
    // #366) and pushes back via the finish handler.
    let task_title = format!(
        "Atendé el review del PR #{} — ronda {}",
        pr_number, completed_reviews
    );

    let task = WorkerTask::prepend_review_fix(
        pool,
        author_worker_id,
        &CreateWorkerTask {
            repo_id,
            title: task_title,
            prompt: task_prompt,
            issue_number: Some(pr_number),
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        },
    )
    .await?;

    info!(
        author_worker_id = %author_worker_id,
        pr_number,
        task_id = %task.id,
        "Dispatched author fix task (fallback) for PR #{}",
        pr_number,
    );

    match try_take_next(config, db, container, author_worker_id).await {
        Ok(started) => info!(
            author_worker_id = %author_worker_id,
            started_task_id = %started.task.id,
            "Author worker started its next queued task after fix dispatch"
        ),
        Err(e) if e.is_conflict() => {}
        Err(StartError::Sqlx(e)) => return Err(e),
        Err(e) => warn!(
            author_worker_id = %author_worker_id,
            "Failed to auto-start author after fix dispatch: {}",
            e
        ),
    }

    Ok(())
}

/// Text of the CI-fix prompt sent to the author when the PR head has a failing
/// CI rollup. Sibling of [`build_remediation_prompt`]: shares its plumbing-free
/// contract (worktree already on the PR head, system pushes and does not
/// create a new PR) but is dispatched by the pr_monitor CI gate (issue #367)
/// instead of a reviewer verdict.
fn build_ci_fix_prompt(pr_number: i64) -> String {
    format!(
        "El CI del PR #{pr_number} está fallando. \
         Tu worktree ya está posicionado sobre el head del PR — no hace \
         falta hacer fetch, checkout, ni reset. \
         Revisá los checks con `gh pr checks {pr_number}` (usá \
         `--watch=false` para no bloquearte), inspeccioná los logs de las \
         corridas fallidas, arreglá lo que las rompe y commiteá. \
         El sistema pushea tus commits a la rama del PR al finalizar la \
         corrida: no pushees a mano ni crees un PR nuevo — el PR ya existe."
    )
}

/// Dispatch a CI-fix task to the PR author worker when the PR head has a
/// failing CI rollup (issue #367). The pr_monitor is the sole caller: it
/// makes this call INSTEAD of `dispatch_review_task` when the CI gate is
/// red, so the reviewer never burns a round on a PR whose checks are broken.
///
/// Reuses the shared `dispatch_remediation_follow_up` primary path and the
/// `prepend_review_fix` fallback used by `dispatch_author_fix_task`. Unlike
/// `dispatch_author_fix_task`, it does NOT gate on "at least one review round
/// completed": CI can break on the very first push, before any reviewer has
/// looked at the PR.
///
/// Idempotency:
/// - Per-head SHA: a `review_rounds` row with `kind='remediation'`,
///   `head_sha`=current head, `reasons={"ci_failing":true}` is inserted after
///   a successful dispatch. Subsequent polls on the same head see that row
///   via `ReviewRound::exists_for_head` and skip. Once the author pushes a
///   fix, the head SHA changes and a fresh dispatch is allowed.
/// - Per-PR "in flight": while a queued/in_progress `review_fix` task exists
///   OR a coding-agent process is live on the workspace, no second CI-fix is
///   dispatched (same defense-in-depth as the review-changes remediation).
///
/// No-op when:
/// - `WORKER_LEAD_ENABLED=false`
/// - No local PullRequest record yet — pr_monitor's next cycle records it
/// - GitHub returns no head SHA (transient — retried next cycle)
pub async fn dispatch_ci_fix_task(
    config: &Arc<RwLock<Config>>,
    db: &DBService,
    container: &(impl ContainerService + Send + Sync),
    pr_number: i64,
    repo_id: Uuid,
    author_worker_id: Uuid,
) -> Result<(), sqlx::Error> {
    if !lead_enabled_from_env() {
        return Ok(());
    }

    let pool = &db.pool;

    // Same in-flight guard as `dispatch_author_fix_task`: while one fix task
    // is queued or in progress for this PR, do not queue a second one. Covers
    // both the legacy `review_fix` task path and interlocks CI fixes with
    // reviewer-requested fixes on the same PR.
    if let Some(pending) =
        WorkerTask::find_pending_review_fix_for_pr(pool, pr_number, repo_id).await?
    {
        debug!(
            pr_number,
            pending_task_id = %pending.id,
            "A fix task for this PR is already pending — skipping duplicate CI-fix dispatch"
        );
        return Ok(());
    }

    // Resolve the PR record + head SHA for the per-head idempotency guard.
    // Bail conservatively on any resolve failure: dispatching against an
    // unknown head would either double-fire on the same head (if we later
    // learn the SHA) or race with a subsequent push.
    let Some(pr_record) = PullRequest::find_by_repo_and_number(pool, repo_id, pr_number).await?
    else {
        debug!(
            pr_number,
            repo_id = %repo_id,
            "No local PullRequest record yet — skipping CI-fix dispatch this cycle"
        );
        return Ok(());
    };

    // Try to use the author's PAT so the head-SHA fetch is attributed to the
    // author's identity — but tolerate PAT-less workers (the fetch itself is
    // a read-only view API and works with the machine's gh account).
    let author = Worker::find_by_id(pool, author_worker_id).await?;
    let author_pat = author.and_then(|w| w.github_pat);
    let git_host = match GitHostService::from_url_with_token(&pr_record.pr_url, author_pat) {
        Ok(gh) => gh,
        Err(e) => {
            debug!(
                pr_number,
                "Cannot construct git host for CI-fix dispatch — skipping this cycle: {}", e
            );
            return Ok(());
        }
    };
    let head_sha = match git_host.get_pr_head_sha(&pr_record.pr_url).await {
        Ok(Some(sha)) if !sha.is_empty() => sha,
        Ok(_) => {
            debug!(
                pr_number,
                "GitHub returned no head SHA for PR — skipping CI-fix dispatch this cycle"
            );
            return Ok(());
        }
        Err(e) => {
            warn!(
                pr_number,
                "Failed to resolve head SHA for CI-fix dispatch — retrying next cycle: {}", e
            );
            return Ok(());
        }
    };

    // Per-head idempotency: one CI-fix per failing head SHA. `exists_for_head`
    // returns true for any remediation row (kind='remediation') on this exact
    // head that is not `failed`, which covers both a still-pending in-flight
    // fix and a fix that already completed on this head.
    if ReviewRound::exists_for_head(
        pool,
        repo_id,
        pr_number,
        review_round::KIND_REMEDIATION,
        &head_sha,
    )
    .await?
    {
        debug!(
            pr_number,
            head_sha = %head_sha,
            "CI-fix already dispatched for this head SHA — skipping"
        );
        return Ok(());
    }

    let task_prompt = build_ci_fix_prompt(pr_number);

    // Primary path: dispatch the CI-fix as a system follow-up on the author's
    // ORIGINAL in_review workspace, same as the reviewer-changes remediation.
    let dispatched = match dispatch_remediation_follow_up(
        db,
        container,
        pr_number,
        repo_id,
        author_worker_id,
        &task_prompt,
    )
    .await
    {
        Ok(true) => {
            info!(
                author_worker_id = %author_worker_id,
                pr_number,
                head_sha = %head_sha,
                "CI-fix dispatched as follow-up on the original task workspace"
            );
            true
        }
        Ok(false) => {
            info!(
                author_worker_id = %author_worker_id,
                pr_number,
                "Original workspace unavailable for CI-fix follow-up — falling back to review_fix task"
            );
            false
        }
        Err(e) => {
            warn!(
                author_worker_id = %author_worker_id,
                pr_number,
                "Follow-up CI-fix dispatch failed — falling back to review_fix task: {}",
                e
            );
            false
        }
    };

    let mut fallback_task_id: Option<Uuid> = None;
    if !dispatched {
        // Fallback: create a `review_fix` task. Shares the kind so it flows
        // through the same scheduler exemption (front-of-queue, exempt from
        // WORKER_MAX_IN_REVIEW) as the reviewer-changes fix.
        let task_title = format!("Arreglá el CI del PR #{}", pr_number);

        let task = WorkerTask::prepend_review_fix(
            pool,
            author_worker_id,
            &CreateWorkerTask {
                repo_id,
                title: task_title,
                prompt: task_prompt,
                issue_number: Some(pr_number),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await?;

        info!(
            author_worker_id = %author_worker_id,
            pr_number,
            task_id = %task.id,
            head_sha = %head_sha,
            "Dispatched CI-fix task (fallback) for PR #{}",
            pr_number,
        );

        fallback_task_id = Some(task.id);

        match try_take_next(config, db, container, author_worker_id).await {
            Ok(started) => info!(
                author_worker_id = %author_worker_id,
                started_task_id = %started.task.id,
                "Author worker started its next queued task after CI-fix dispatch"
            ),
            Err(e) if e.is_conflict() => {}
            Err(StartError::Sqlx(e)) => return Err(e),
            Err(e) => warn!(
                author_worker_id = %author_worker_id,
                "Failed to auto-start author after CI-fix dispatch: {}",
                e
            ),
        }
    }

    // Record the remediation round so the head-SHA idempotency guard fires
    // on the next poll. `reasons` distinguishes CI-fix from reviewer-changes
    // fix for anyone querying the ledger later. Best-effort: if the insert
    // fails we log and continue — a duplicate dispatch on the next cycle is
    // the pathological worst case, and the in-flight WorkerTask guard above
    // will still catch it while the current fix is running.
    if let Err(e) = ReviewRound::create(
        pool,
        &CreateReviewRound {
            repo_id,
            pr_number,
            kind: review_round::KIND_REMEDIATION.to_string(),
            head_sha: head_sha.clone(),
            base_sha: None,
            task_id: fallback_task_id,
            reasons: Some(r#"{"ci_failing":true}"#.to_string()),
        },
    )
    .await
    {
        warn!(
            pr_number,
            head_sha = %head_sha,
            "Failed to insert review_rounds row for CI-fix dispatch: {}",
            e
        );
    }

    Ok(())
}

fn worker_workspace_name(worker: &Worker, task: &WorkerTask) -> String {
    let title = task.title.trim();
    if title.is_empty() {
        worker.name.clone()
    } else {
        format!("{} — {}", worker.name, title)
    }
}

fn build_worker_prompt(soul: &str, task_prompt: &str, target_branch: &str, role: &str) -> String {
    let base = crate::services::base_instructions::effective_base_instructions();
    let soul = soul.trim();
    let task_prompt = task_prompt.trim();
    let final_instruction = if role == ROLE_DEVELOPER {
        WORKER_FINAL_INSTRUCTION_TEMPLATE.replace("{target_branch}", target_branch)
    } else if role == ROLE_ANALYST {
        ANALYST_ROLE_INSTRUCTION.to_string()
    } else if role == ROLE_DESIGNER {
        DESIGNER_ROLE_INSTRUCTION.to_string()
    } else {
        NON_DEVELOPER_FINAL_INSTRUCTION.to_string()
    };
    let mut prompt = format!(
        "[SYSTEM BASE INSTRUCTIONS — these take precedence over the worker soul in any conflict]\n\n\
         {base}\n\n\
         ---\n\n\
         [WORKER SOUL]\n\n\
         {soul}\n\n\
         ---\n\n\
         {task_prompt}\n\n\
         ---\n\n\
         {final_instruction}"
    );
    // Analyst-only appendix: declared write ops flow through `.vk/actions.json`,
    // not `gh`. Placed at the very end so the outbox contract wins any conflict
    // with earlier prompt text (soul / task prompt / role framing).
    if role == ROLE_ANALYST {
        prompt.push_str("\n\n---\n\n");
        prompt.push_str(ANALYST_ACTIONS_JSON_CONTRACT);
        // Follows the outbox contract rather than preceding it: the label
        // convention is a refinement of `create_issue.labels`, so it must be
        // read with the outbox mechanics already in hand.
        prompt.push_str("\n\n---\n\n");
        prompt.push_str(ANALYST_EXECUTION_LABELS_CONTRACT);
    }
    prompt
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::TimeZone;
    use db::models::{repo::Repo, worker::CreateWorker, worker_task::CreateWorkerTask};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::*;
    // Ties the prompt text to the parser's prefixes: if one side renames a
    // label family, the prompt assertions fail instead of the convention
    // silently splitting in two.
    use crate::services::execution_labels;

    /// The finalizing-guard is the entire mechanism that hides the "stalled"
    /// flash while the orchestrator publishes the PR (issue #494): if it stops
    /// clearing on drop, cards get stuck showing `is_finalizing=true` forever.
    #[test]
    fn finalizing_guard_sets_and_clears_flag() {
        let workspace_id = Uuid::new_v4();
        assert!(!is_workspace_finalizing(workspace_id));
        {
            let _guard = FinalizingGuard::new(workspace_id);
            assert!(is_workspace_finalizing(workspace_id));
        }
        assert!(!is_workspace_finalizing(workspace_id));
    }

    /// The guard must clear on drop even when the enclosing function panics —
    /// the acceptance criterion is "no stuck flag on failure of any kind".
    #[test]
    fn finalizing_guard_clears_on_panic() {
        let workspace_id = Uuid::new_v4();
        let result = std::panic::catch_unwind(|| {
            let _guard = FinalizingGuard::new(workspace_id);
            panic!("simulated push failure");
        });
        assert!(result.is_err());
        assert!(!is_workspace_finalizing(workspace_id));
    }

    #[test]
    fn builds_prompt_with_base_instructions_soul_task_and_final_instruction() {
        let prompt = build_worker_prompt("  soul  ", "  do it  ", "main", ROLE_DEVELOPER);
        // Base instructions come first
        assert!(prompt.starts_with("[SYSTEM BASE INSTRUCTIONS"));
        // All sections are present
        assert!(prompt.contains("[WORKER SOUL]"));
        assert!(prompt.contains("soul"));
        assert!(prompt.contains("do it"));
        assert!(prompt.contains("`main`"));
        // System now handles push/PR; agent must NOT be told to use gh pr create
        assert!(
            !prompt.contains("gh pr create"),
            "developer prompt must not instruct agent to create PR"
        );
        assert!(prompt.contains("do NOT create the PR"));
        // Base instructions precede the soul
        let base_pos = prompt.find("[SYSTEM BASE INSTRUCTIONS").unwrap();
        let soul_pos = prompt.find("[WORKER SOUL]").unwrap();
        let task_pos = prompt.find("do it").unwrap();
        assert!(base_pos < soul_pos);
        assert!(soul_pos < task_pos);
    }

    /// The env var precedence tests share a single process-global variable,
    /// so they must not run in parallel with one another or with any other
    /// test that touches WORKER_REVIEW_MAX_ROUNDS. They are grouped in one
    /// test to keep the mutation window as short and self-contained as
    /// possible.
    #[test]
    fn resolve_max_review_rounds_precedence() {
        // SAFETY: no other test in this crate reads or writes
        // WORKER_REVIEW_MAX_ROUNDS.
        unsafe {
            std::env::remove_var(WORKER_REVIEW_MAX_ROUNDS_ENV);
        }

        // Baseline: Config value is used when no env override is set.
        let mut cfg = Config::default();
        cfg.max_review_rounds = 5;
        assert_eq!(resolve_max_review_rounds(&cfg), 5);

        // Env override wins over Config when set to a positive integer.
        unsafe {
            std::env::set_var(WORKER_REVIEW_MAX_ROUNDS_ENV, "7");
        }
        assert_eq!(resolve_max_review_rounds(&cfg), 7);

        // Non-positive env values are ignored (fall through to Config).
        unsafe {
            std::env::set_var(WORKER_REVIEW_MAX_ROUNDS_ENV, "0");
        }
        assert_eq!(resolve_max_review_rounds(&cfg), 5);
        unsafe {
            std::env::set_var(WORKER_REVIEW_MAX_ROUNDS_ENV, "not-a-number");
        }
        assert_eq!(resolve_max_review_rounds(&cfg), 5);

        // Config = 0 with no usable env → hardcoded default.
        unsafe {
            std::env::remove_var(WORKER_REVIEW_MAX_ROUNDS_ENV);
        }
        cfg.max_review_rounds = 0;
        assert_eq!(resolve_max_review_rounds(&cfg), DEFAULT_MAX_REVIEW_ROUNDS);
    }

    #[test]
    fn builds_prompt_without_pr_instruction_for_analyst() {
        let prompt = build_worker_prompt("soul", "do it", "main", db::models::worker::ROLE_ANALYST);
        assert!(!prompt.contains("gh pr create"));
        assert!(prompt.contains("Do NOT create any PR"));
        // Analysts get ticket-writing framing, not the generic non-dev one:
        // they must not investigate or solve the problem themselves.
        assert!(prompt.contains("business analyst"));
        assert!(prompt.contains("do NOT hunt for root causes"));
    }

    /// Issue #540: the analyst prompt must carry the `.vk/actions.json`
    /// outbox contract — path, the FULL F1+F2 kind catalog, placeholder
    /// syntax, and the ban on `gh` writes that DO have an outbox kind —
    /// appended AFTER the role framing so it wins any conflict with older
    /// "created via `gh`" language.
    ///
    /// The kind list must include `comment_issue` because
    /// `ANALYST_ROLE_INSTRUCTION` still promises a plan-comment deliverable;
    /// leaking that write back to `gh issue comment` would violate the ban.
    #[test]
    fn analyst_prompt_appends_actions_json_contract() {
        let prompt = build_worker_prompt("soul", "do it", "main", ROLE_ANALYST);

        // Path and every kind in the full F1+F2 catalog must appear so the
        // analyst learns the complete wire shape from the prompt alone.
        assert!(prompt.contains(".vk/actions.json"));
        assert!(prompt.contains("create_milestone"));
        assert!(prompt.contains("create_issue"));
        assert!(prompt.contains("close_issue"));
        // F1 kinds — needed so the plan-comment deliverable routes through
        // the outbox instead of falling back to `gh issue comment`.
        assert!(prompt.contains("comment_issue"));
        assert!(prompt.contains("comment_pr"));

        // Placeholder syntax stays literal (double curlies), since the drain
        // parses `{{action[N].number}}` / `{{action[N].url}}` verbatim.
        assert!(prompt.contains("{{action[0].number}}"));
        assert!(prompt.contains("{{action[N].number}}"));
        assert!(prompt.contains("{{action[N].url}}"));

        // Ban is scoped to `gh` writes that already have an outbox kind;
        // untouched writes like `gh issue edit` (F3) are explicitly allowed
        // transitionally so the analyst is never banned without an alternative.
        assert!(prompt.contains("gh issue create"));
        assert!(prompt.contains("gh issue comment"));
        assert!(prompt.contains("Do NOT execute the `gh` write commands"));
        assert!(
            prompt.contains("transitionally"),
            "contract must leave writes without an outbox kind on `gh` transitionally"
        );

        // The contract sits AFTER the role framing so it takes precedence
        // over the earlier "created via `gh`" phrasing in the role blurb.
        let role_pos = prompt
            .find("business analyst")
            .expect("role framing present");
        let contract_pos = prompt
            .find("[AGENT ACTIONS")
            .expect("actions.json contract present");
        assert!(
            role_pos < contract_pos,
            "actions.json contract must be appended AFTER the analyst role framing"
        );
        // Only the execution-label contract may follow it. That one refines
        // `create_issue.labels` rather than competing with the outbox
        // mechanics, so it cannot walk the contract back — anything else
        // appended here would.
        let labels_pos = prompt
            .find("[EXECUTION LABELS")
            .expect("execution labels contract present");
        assert!(
            contract_pos < labels_pos,
            "labels contract must come after the outbox contract it refines"
        );
        assert!(prompt.trim_end().ends_with("crosses that line."));
    }

    /// The label convention IS the execution-graph feature: there is no
    /// dependency table and no inference, so anything the analyst fails to
    /// emit here is information the board can never recover. These assertions
    /// pin the parts that carry meaning, not the prose around them.
    #[test]
    fn analyst_prompt_appends_execution_labels_contract() {
        let prompt = build_worker_prompt("soul", "do it", "main", ROLE_ANALYST);

        // The three label families, with the exact prefixes the parsers use.
        assert!(prompt.contains(execution_labels::FEATURE_PREFIX));
        assert!(prompt.contains(execution_labels::WAVE_PREFIX));
        assert!(prompt.contains(execution_labels::RESOURCE_PREFIX));

        // All four same-wave conditions must be spelled out. An analyst that
        // checks only "is there a dependency?" reproduces the 14-ago-2026
        // finding: two issues sharing no file and no dependency still
        // collided over an undecided enum discriminator.
        for condition in [
            "Neither needs the other's code",
            "do not modify the same file",
            "same serialized resource",
            "no decision shared between them still open",
        ] {
            assert!(
                prompt.contains(condition),
                "same-wave condition missing from the contract: {condition}"
            );
        }

        // The conservative default, and the numbering rule that keeps already
        // labelled issues valid.
        assert!(prompt.contains("give the issue a wave of its own"));
        assert!(prompt.contains("NEVER renumber"));

        // `resource:` is the only cross-feature signal; if the prompt stops
        // saying so, the migration-collision case silently comes back.
        assert!(prompt.contains("the only label that CROSSES features"));

        // The mechanism: labels ride on `create_issue`, and `add_labels`
        // covers issues the analyst did not create.
        assert!(prompt.contains("add_labels"));
    }

    /// Same rationale as the outbox contract: only analysts create issues, so
    /// only analysts get the labelling rules.
    #[test]
    fn execution_labels_contract_is_analyst_only() {
        for role in [ROLE_DEVELOPER, ROLE_REVIEWER, ROLE_DESIGNER] {
            let prompt = build_worker_prompt("soul", "do it", "main", role);
            assert!(
                !prompt.contains("[EXECUTION LABELS"),
                "role {role} must not receive the execution labels contract"
            );
        }
    }

    /// The `.vk/actions.json` contract is analyst-only: no other role gets a
    /// write-outbox to declare into, so leaking it would confuse them.
    #[test]
    fn actions_json_contract_is_analyst_only() {
        for role in [ROLE_DEVELOPER, ROLE_REVIEWER, ROLE_DESIGNER] {
            let prompt = build_worker_prompt("soul", "do it", "main", role);
            assert!(
                !prompt.contains(".vk/actions.json"),
                "role {role} must not receive the analyst actions.json contract"
            );
            assert!(
                !prompt.contains("[AGENT ACTIONS"),
                "role {role} must not receive the analyst actions.json contract header"
            );
        }
    }

    #[test]
    fn builds_prompt_without_pr_instruction_for_reviewer() {
        let prompt =
            build_worker_prompt("soul", "do it", "main", db::models::worker::ROLE_REVIEWER);
        assert!(!prompt.contains("gh pr create"));
        assert!(prompt.contains("Do NOT create any PR"));
    }

    /// Spec §A1/A2 + issue #366: the reviewer prompt must direct the agent
    /// to `.vk/review.json` and MUST NOT ask it to run `gh pr review …`,
    /// `gh pr checkout`, `git fetch pull/N/head`, or any other network-side
    /// positioning — the system materializes the worktree already anchored
    /// on the pinned SHA (`LocalContainerService::create` →
    /// `WorkspaceManager::create_workspace` with a pinned `starting_point`).
    /// The head SHA still travels in-prompt so the agent knows which commit
    /// its verdict will be pinned to.
    #[test]
    fn reviewer_prompt_targets_review_json_and_pins_sha() {
        let prompt = quick_action_prompts::format_review_pr_prompt(304, "deadbeef1234567890");
        assert!(
            prompt.contains(".vk/review.json"),
            "reviewer prompt must reference .vk/review.json"
        );
        assert!(
            prompt.contains("deadbeef1234567890"),
            "reviewer prompt must include the pinned head SHA"
        );
        // Forbid the invocation forms — the prompt should never tell the
        // agent to *execute* these.
        assert!(
            !prompt.contains("gh pr review --approve")
                && !prompt.contains("gh pr review --request-changes"),
            "reviewer prompt must not execute gh pr review flags"
        );
        assert!(
            !prompt.contains("gh pr checkout"),
            "reviewer prompt must not execute gh pr checkout — the system pre-positions the worktree"
        );
        // Issue #366: the fetch/checkout is now handled server-side at
        // workspace materialization. The prompt must not ask the agent to
        // redo it.
        assert!(
            !prompt.contains("git fetch") && !prompt.contains("git checkout"),
            "reviewer prompt must not ask the agent to fetch/checkout — the worktree is already at the head SHA"
        );
        assert!(
            !prompt.contains("FETCH_HEAD"),
            "reviewer prompt must not reference FETCH_HEAD"
        );
        assert!(
            prompt.contains("request_changes"),
            "reviewer prompt must describe the verdict values"
        );
    }

    /// Issue #366: the fix-task remediation prompt must be free of git
    /// plumbing — the system positions the worktree on the PR head at
    /// materialization and pushes on finish. Any `reset --hard` /
    /// `git push` / `pull/N/head` in the prompt would either race the
    /// server-managed state or force the agent to duplicate work.
    ///
    /// Covered against both the inline-comments and the `gh` fallback
    /// variants of the prompt (issue #368): the "no plumbing" contract must
    /// hold regardless of whether enrichment succeeded.
    #[test]
    fn remediation_prompt_has_no_git_plumbing() {
        for (owner_repo, comments_block) in [
            (
                Some("mdevel-uy/vibe-kanban"),
                Some("Comentario del reviewer"),
            ),
            (Some("mdevel-uy/vibe-kanban"), None),
            (None, None),
        ] {
            let prompt = build_remediation_prompt(
                507,
                "https://github.com/mdevel-uy/vibe-kanban/pull/507",
                owner_repo,
                comments_block,
            );
            assert!(
                prompt.contains("PR #507"),
                "remediation prompt must reference the PR number"
            );
            assert!(
                !prompt.contains("reset --hard"),
                "remediation prompt must not tell the agent to run reset --hard"
            );
            assert!(
                !prompt.contains("git push"),
                "remediation prompt must not tell the agent to run git push"
            );
            assert!(
                !prompt.contains("pull/507/head") && !prompt.contains("FETCH_HEAD"),
                "remediation prompt must not tell the agent to fetch pull/N/head"
            );
            assert!(
                !prompt.contains("gh pr checkout"),
                "remediation prompt must not tell the agent to run gh pr checkout"
            );
            // Regression cover for PR #490: never emit `gh -R <full-url>`.
            assert!(
                !prompt.contains("-R https://"),
                "remediation prompt must not emit `-R <full-url>`"
            );
        }
    }

    /// Issue #367: the CI-fix prompt is a sibling of the reviewer-changes
    /// remediation prompt and shares its plumbing-free contract. The worktree
    /// arrives at the PR head, the system pushes on finish, and the PR
    /// already exists — none of that git bookkeeping belongs in the prompt.
    #[test]
    fn ci_fix_prompt_has_no_git_plumbing_and_names_the_pr() {
        let prompt = build_ci_fix_prompt(507);
        assert!(
            prompt.contains("PR #507"),
            "CI-fix prompt must reference the PR number"
        );
        assert!(
            prompt.contains("gh pr checks 507"),
            "CI-fix prompt must point the author at `gh pr checks` for diagnosis"
        );
        assert!(
            !prompt.contains("reset --hard"),
            "CI-fix prompt must not tell the agent to run reset --hard"
        );
        assert!(
            !prompt.contains("git push"),
            "CI-fix prompt must not tell the agent to run git push"
        );
        assert!(
            !prompt.contains("pull/507/head") && !prompt.contains("FETCH_HEAD"),
            "CI-fix prompt must not tell the agent to fetch pull/N/head"
        );
        assert!(
            !prompt.contains("gh pr checkout"),
            "CI-fix prompt must not tell the agent to run gh pr checkout"
        );
        assert!(
            !prompt.contains("gh pr create"),
            "CI-fix prompt must not tell the agent to open a new PR"
        );
    }

    /// Idempotency contract for the CI-fix dispatch (issue #367): once a
    /// remediation round is recorded for a given (repo, PR, head SHA), the
    /// `exists_for_head` guard fires so a redispatch on the same failing head
    /// is a no-op. This is the mechanism `dispatch_ci_fix_task` relies on to
    /// avoid burning a fresh agent run every poll while CI is still red on the
    /// same commit.
    #[tokio::test]
    async fn ci_fix_head_sha_guard_blocks_second_dispatch_on_same_head() {
        let db = setup_test_db().await;
        let (repo, _temp) = insert_repo(&db, "ci-fix-guard-repo").await;
        let pr_number: i64 = 4242;
        let head_sha = "deadbeefcafefeed1234567890abcdef00000000";

        // No round yet — the guard should let the first dispatch through.
        assert!(
            !ReviewRound::exists_for_head(
                &db.pool,
                repo.id,
                pr_number,
                review_round::KIND_REMEDIATION,
                head_sha,
            )
            .await
            .unwrap()
        );

        // Simulate what dispatch_ci_fix_task writes after a successful
        // dispatch: a remediation round pinned to this head SHA, marked as
        // CI-driven for anyone querying the ledger later.
        ReviewRound::create(
            &db.pool,
            &CreateReviewRound {
                repo_id: repo.id,
                pr_number,
                kind: review_round::KIND_REMEDIATION.to_string(),
                head_sha: head_sha.to_string(),
                base_sha: None,
                task_id: None,
                reasons: Some(r#"{"ci_failing":true}"#.to_string()),
            },
        )
        .await
        .unwrap();

        // Same head: guard trips — no duplicate CI-fix.
        assert!(
            ReviewRound::exists_for_head(
                &db.pool,
                repo.id,
                pr_number,
                review_round::KIND_REMEDIATION,
                head_sha,
            )
            .await
            .unwrap()
        );

        // A new head (author pushed a fix that still didn't clear CI) should
        // NOT be blocked by the previous head's row — a fresh dispatch on the
        // new failing head is exactly what the CI gate wants.
        let new_head = "beadfeedcafedead1111111111111111ffffffff";
        assert!(
            !ReviewRound::exists_for_head(
                &db.pool,
                repo.id,
                pr_number,
                review_round::KIND_REMEDIATION,
                new_head,
            )
            .await
            .unwrap()
        );
    }

    #[test]
    fn builds_prompt_with_designer_framing_for_designer() {
        let prompt =
            build_worker_prompt("soul", "do it", "main", db::models::worker::ROLE_DESIGNER);
        assert!(!prompt.contains("gh pr create"));
        // Designer must not be told to create PRs or issues; the deliverable
        // is committed HTML under design/ (served rendered by the preview
        // endpoint), so the role-specific framing must show up.
        assert!(prompt.contains("UI/UX designer"));
        assert!(prompt.contains("`design/`"));
        assert!(prompt.contains("COMMIT the files to the workspace branch"));
        assert!(prompt.contains("never open a PR"));
    }

    async fn setup_test_db() -> DBService {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("open pool");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        DBService { pool }
    }

    async fn insert_repo(db: &DBService, name: &str) -> (Repo, TempDir) {
        let temp = TempDir::new().expect("tempdir");
        let path: PathBuf = temp.path().join(name);
        std::fs::create_dir_all(&path).expect("mkdir");
        let repo = Repo::find_or_create(&db.pool, &path, name)
            .await
            .expect("insert repo");
        (repo, temp)
    }

    async fn insert_worker(db: &DBService, name: &str) -> Worker {
        insert_worker_with_role(db, name, None).await
    }

    async fn insert_reviewer(db: &DBService, name: &str) -> Worker {
        insert_worker_with_role(
            db,
            name,
            Some(db::models::worker::ROLE_REVIEWER.to_string()),
        )
        .await
    }

    async fn insert_worker_with_role(db: &DBService, name: &str, role: Option<String>) -> Worker {
        Worker::create(
            &db.pool,
            &CreateWorker {
                name: name.to_string(),
                emoji: "🤖".to_string(),
                soul: "test soul".to_string(),
                role,
                executor: None,
                model: None,
                github_pat: None,
                github_login: None,
                plan_mode: None,
            },
        )
        .await
        .expect("insert worker")
    }

    async fn insert_workspace(db: &DBService) -> Workspace {
        Workspace::create(
            &db.pool,
            &CreateWorkspace {
                branch: format!("test-branch-{}", Uuid::new_v4()),
                name: Some("test workspace".to_string()),
            },
            Uuid::new_v4(),
        )
        .await
        .expect("insert workspace")
    }

    #[tokio::test]
    async fn reconcile_archives_orphan_workspace_attached_to_worker() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "wall-e").await;
        let workspace = insert_workspace(&db).await;

        // Simulate the zombie state: workspace attached to worker, no active
        // worker_task pointing at it, not archived.
        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();

        assert_eq!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap(),
            vec![workspace.id]
        );

        reconcile_worker_workspaces(&db, worker.id).await.unwrap();

        // Workspace should now be archived and detached — capacity guard
        // sees a clean slate.
        assert!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap()
                .is_empty()
        );
        let refreshed = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(refreshed.archived, "workspace should be archived");
    }

    #[tokio::test]
    async fn append_persists_desk_source() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "desk").await;
        let (repo, _repo_tmp) = insert_repo(&db, "desk-repo").await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "pedido".to_string(),
                prompt: "investigar".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_DESK.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert_eq!(task.source, worker_task::SOURCE_DESK);
        assert_eq!(task.status, worker_task::STATUS_QUEUED);
    }

    /// Territory globs (issue #95) survive a persistence round-trip and read
    /// back through the model accessor. An empty vector must be persisted as
    /// SQL `NULL` so the "no territory declared" state stays visible to
    /// humans auditing the row.
    #[tokio::test]
    async fn append_persists_territory_globs_and_reads_back() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "dev").await;
        let (repo, _repo_tmp) = insert_repo(&db, "territory-repo").await;

        let with_territory = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "with territory".to_string(),
                prompt: "prompt".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: vec![
                    "crates/services/**".to_string(),
                    "crates/db/models/worker_task.rs".to_string(),
                ],
            },
        )
        .await
        .unwrap();

        assert_eq!(
            with_territory.territory_globs_parsed(),
            vec![
                "crates/services/**".to_string(),
                "crates/db/models/worker_task.rs".to_string()
            ]
        );
        assert!(with_territory.territory_globs.is_some());

        let without_territory = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "no territory".to_string(),
                prompt: "prompt".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert!(without_territory.territory_globs.is_none());
        assert!(without_territory.territory_globs_parsed().is_empty());
    }

    /// Regression for the `approved` state: `WorkerTask::set_status` must be
    /// able to move a task from `in_review` to `approved` against the real
    /// schema. If the CHECK constraint on `worker_tasks.status` is missing
    /// the value, sqlx bubbles a `SQLITE_CONSTRAINT_CHECK` error, the
    /// auto-transition in `pr_monitor`/`worker_orchestrator` silently warns,
    /// and the task stays stuck in `in_review` forever.
    #[tokio::test]
    async fn set_status_accepts_approved_against_check_constraint() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "dev").await;
        let (repo, _repo_tmp) = insert_repo(&db, "approved-repo").await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "feature".to_string(),
                prompt: "ship it".to_string(),
                issue_number: Some(1),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_IN_REVIEW)
            .await
            .expect("in_review is a valid status");
        let approved = WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_APPROVED)
            .await
            .expect("approved must be accepted by the status CHECK");
        assert_eq!(approved.status, worker_task::STATUS_APPROVED);

        // count_in_review folds `approved` into the same slot bucket as
        // `in_review` — verify the DB read agrees after the transition.
        assert_eq!(
            WorkerTask::count_in_review(&db.pool, worker.id)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn reconcile_leaves_workspace_with_active_task_alone() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "eve").await;
        let (repo, _repo_tmp) = insert_repo(&db, "eve-repo").await;
        let workspace = insert_workspace(&db).await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "wire it up".to_string(),
                prompt: "do the thing".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_workspace_id(&db.pool, task.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_IN_PROGRESS)
            .await
            .unwrap();

        reconcile_worker_workspaces(&db, worker.id).await.unwrap();

        // Healthy workspace with in_progress task must not be touched.
        assert_eq!(
            Worker::active_workspace_ids(&db.pool, worker.id)
                .await
                .unwrap(),
            vec![workspace.id]
        );
        let refreshed = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(
            !refreshed.archived,
            "healthy workspace must not be archived"
        );
    }

    #[tokio::test]
    async fn rollback_workspace_archives_detaches_and_clears_task_link() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "burn-e").await;
        let (repo, _repo_tmp) = insert_repo(&db, "burn-repo").await;
        let workspace = insert_workspace(&db).await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "cleanup".to_string(),
                prompt: "clean".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        Worker::attach_workspace(&db.pool, worker.id, workspace.id)
            .await
            .unwrap();
        WorkerTask::set_workspace_id(&db.pool, task.id, workspace.id)
            .await
            .unwrap();

        rollback_workspace(&db, workspace.id).await;

        let refreshed_ws = Workspace::find_by_id(&db.pool, workspace.id)
            .await
            .unwrap()
            .expect("workspace still exists");
        assert!(refreshed_ws.archived, "workspace should be archived");
        assert!(
            Worker::find_by_workspace_id(&db.pool, workspace.id)
                .await
                .unwrap()
                .is_none(),
            "worker link should be cleared",
        );

        let refreshed_task = WorkerTask::find_by_id(&db.pool, task.id)
            .await
            .unwrap()
            .expect("task still exists");
        assert!(
            refreshed_task.workspace_id.is_none(),
            "task workspace_id should be cleared",
        );
    }

    #[tokio::test]
    async fn rollback_survives_reruns_when_workspace_missing() {
        // Rollback is best-effort: a caller that runs it twice, or against
        // a workspace that no longer exists in the DB, must not panic.
        let db = setup_test_db().await;
        rollback_workspace(&db, Uuid::new_v4()).await;
    }

    #[tokio::test]
    async fn try_claim_is_exclusive_per_task_and_worker() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "gasty").await;
        let (repo, _repo_tmp) = insert_repo(&db, "claim-repo").await;
        let make_task = |title: &str| CreateWorkerTask {
            repo_id: repo.id,
            title: title.to_string(),
            prompt: "do it".to_string(),
            issue_number: None,
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        };
        let task_a = WorkerTask::append(&db.pool, worker.id, &make_task("a"))
            .await
            .unwrap();
        let task_b = WorkerTask::append(&db.pool, worker.id, &make_task("b"))
            .await
            .unwrap();

        // First claim wins; the same task cannot be claimed twice (this is
        // the double-dispatch race: two concurrent start_next calls holding
        // the same queued task).
        assert!(
            WorkerTask::try_claim(&db.pool, task_a.id, worker.id)
                .await
                .unwrap()
        );
        assert!(
            !WorkerTask::try_claim(&db.pool, task_a.id, worker.id)
                .await
                .unwrap()
        );

        // A different queued task is also blocked while the worker already
        // has one in progress.
        assert!(
            !WorkerTask::try_claim(&db.pool, task_b.id, worker.id)
                .await
                .unwrap()
        );

        // Releasing the unlinked claim re-queues it and frees the worker.
        WorkerTask::release_claim(&db.pool, task_a.id)
            .await
            .unwrap();
        let refreshed = WorkerTask::find_by_id(&db.pool, task_a.id)
            .await
            .unwrap()
            .expect("task still exists");
        assert_eq!(refreshed.status, worker_task::STATUS_QUEUED);
        assert!(
            WorkerTask::try_claim(&db.pool, task_b.id, worker.id)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn release_claim_leaves_linked_tasks_alone() {
        // A task that already has a workspace belongs to a live run — a
        // stray release must not silently re-queue it.
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "gasty").await;
        let (repo, _repo_tmp) = insert_repo(&db, "release-repo").await;
        let workspace = insert_workspace(&db).await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "linked".to_string(),
                prompt: "do it".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert!(
            WorkerTask::try_claim(&db.pool, task.id, worker.id)
                .await
                .unwrap()
        );
        WorkerTask::set_workspace_id(&db.pool, task.id, workspace.id)
            .await
            .unwrap();

        WorkerTask::release_claim(&db.pool, task.id).await.unwrap();

        let refreshed = WorkerTask::find_by_id(&db.pool, task.id)
            .await
            .unwrap()
            .expect("task still exists");
        assert_eq!(refreshed.status, worker_task::STATUS_IN_PROGRESS);
        assert_eq!(refreshed.workspace_id, Some(workspace.id));
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_is_empty_when_no_reviewer_configured() {
        // dispatch_review_task's first branch: with no reviewer registered the
        // LRU list is empty and the caller must skip dispatch entirely
        // (same no-op the old find_first_reviewer branch produced).
        let db = setup_test_db().await;
        let _dev = insert_worker(&db, "dev-only").await;

        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert!(
            list.is_empty(),
            "developer-only fleet must not surface as a reviewer candidate"
        );
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_excludes_archived_reviewers() {
        // An archived reviewer identity must never receive a fresh review
        // dispatch — even if it's the only one with a `reviewer` role.
        let db = setup_test_db().await;
        let reviewer = insert_reviewer(&db, "retired").await;
        Worker::set_archived(&db.pool, reviewer.id, true)
            .await
            .unwrap();

        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert!(
            list.is_empty(),
            "archived reviewer must not appear in the LRU candidate list"
        );
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_single_reviewer_matches_legacy_pick() {
        // Acceptance criterion: with a single active reviewer the behavior
        // is unchanged — the LRU list has one entry that is the same
        // reviewer the old find_first_reviewer helper would have returned.
        let db = setup_test_db().await;
        let solo = insert_reviewer(&db, "solo").await;

        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, solo.id);
        assert_eq!(
            list[0].id,
            Worker::find_first_reviewer(&db.pool)
                .await
                .unwrap()
                .unwrap()
                .id,
        );
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_puts_never_assigned_before_assigned() {
        // Reviewer A is the oldest identity and already has a task on its
        // ledger; reviewer B was created later and has never taken a task.
        // The LRU rule (nulls first) must surface B ahead of A so B gets
        // the next review — otherwise A keeps accumulating work.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "lru-null-repo").await;
        let reviewer_a = insert_reviewer(&db, "alpha").await;
        let _reviewer_b = insert_reviewer(&db, "bravo").await;

        WorkerTask::append(
            &db.pool,
            reviewer_a.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "Review PR #1".to_string(),
                prompt: "review".to_string(),
                issue_number: Some(1),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "bravo", "never-assigned reviewer must lead");
        assert_eq!(list[1].name, "alpha");
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_rotates_after_each_append() {
        // Simulates the core bug scenario: two reviewers, several review
        // tasks dispatched back-to-back. After appending a task to whoever
        // the LRU currently surfaces, the OTHER reviewer must move to the
        // head so the next dispatch picks them — otherwise all tasks pile
        // onto the same identity (issue #302).
        //
        // Each task's `created_at` is stamped explicitly with a monotonic
        // offset so the `ORDER BY MAX(created_at)` on the LRU query has a
        // well-defined winner without depending on wall-clock progress
        // between iterations (CI schedulers can pin many inserts into the
        // same sub-millisecond bucket, which used to make this flaky).
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "lru-rotate-repo").await;
        let reviewer_a = insert_reviewer(&db, "alpha").await;
        let reviewer_b = insert_reviewer(&db, "bravo").await;

        let base = chrono::Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let mut sequence: Vec<String> = Vec::new();
        for (i, pr_number) in (1..=4i64).enumerate() {
            let picked = Worker::list_active_reviewers_lru(&db.pool)
                .await
                .unwrap()
                .into_iter()
                .next()
                .expect("at least one reviewer available");
            sequence.push(picked.name.clone());
            let task = WorkerTask::append(
                &db.pool,
                picked.id,
                &CreateWorkerTask {
                    repo_id: repo.id,
                    title: format!("Review PR #{pr_number}"),
                    prompt: "review".to_string(),
                    issue_number: Some(pr_number),
                    skills: Vec::new(),
                    issue_labels: Vec::new(),
                    source: worker_task::SOURCE_KANBAN.to_string(),
                    territory_globs: Vec::new(),
                },
            )
            .await
            .unwrap();
            let stamped = base + chrono::Duration::seconds(i as i64);
            sqlx::query("UPDATE worker_tasks SET created_at = ?1 WHERE id = ?2")
                .bind(stamped)
                .bind(task.id)
                .execute(&db.pool)
                .await
                .unwrap();
        }

        // Four consecutive dispatches over two reviewers must alternate
        // rather than all landing on the oldest one.
        assert_eq!(
            sequence,
            vec![
                "alpha".to_string(),
                "bravo".to_string(),
                "alpha".to_string(),
                "bravo".to_string(),
            ],
            "reviewers must rotate under LRU; got {:?}",
            sequence,
        );

        // Sanity: both identities ended up with the same number of tasks.
        let count_a = WorkerTask::list_by_worker(&db.pool, reviewer_a.id)
            .await
            .unwrap()
            .len();
        let count_b = WorkerTask::list_by_worker(&db.pool, reviewer_b.id)
            .await
            .unwrap()
            .len();
        assert_eq!(count_a, 2);
        assert_eq!(count_b, 2);
    }

    #[tokio::test]
    async fn list_active_reviewers_lru_self_review_fallback_prefers_next_candidate() {
        // Guard preservation: when the LRU-first candidate is the PR author,
        // dispatch_review_task walks the list and picks the next non-author
        // reviewer. This test exercises the same fallback path at the
        // candidate-list level: skip the author, pick the next.
        let db = setup_test_db().await;
        let (_repo, _repo_tmp) = insert_repo(&db, "self-review-repo").await;
        let author_reviewer = insert_reviewer(&db, "author").await;
        let other_reviewer = insert_reviewer(&db, "other").await;

        // The author reviewer has never taken a task, so LRU surfaces them
        // first. The fallback must still land on the "other" reviewer.
        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert_eq!(list[0].id, author_reviewer.id);

        let picked = list.into_iter().find(|r| r.id != author_reviewer.id);
        assert_eq!(
            picked.map(|r| r.id),
            Some(other_reviewer.id),
            "must fall through to a non-author reviewer",
        );

        // And when the only reviewer is the author, the fallback returns
        // None — same no-op the pre-balancing dispatch produced.
        Worker::set_archived(&db.pool, other_reviewer.id, true)
            .await
            .unwrap();
        let list = Worker::list_active_reviewers_lru(&db.pool).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(
            !list.iter().any(|r| r.id != author_reviewer.id),
            "no non-author reviewer means dispatch must no-op",
        );

        // Sanity: dispatch would skip in that branch, so the author's task
        // ledger stays empty on this run.
        let count = WorkerTask::list_by_worker(&db.pool, author_reviewer.id)
            .await
            .unwrap()
            .len();
        assert_eq!(count, 0);
    }

    /// Force a worker_task into `in_review` status so that
    /// `WorkerTask::count_in_review` returns a value that trips the
    /// dispatch-time capacity guard. The state-machine documented at the
    /// top of this module says reviewer tasks go `queued → in_progress →
    /// done` (they don't reach `in_review` on their own), so this helper
    /// bypasses the orchestrator's normal transitions purely for test
    /// scaffolding.
    async fn force_in_review(pool: &sqlx::SqlitePool, task_id: Uuid) {
        sqlx::query("UPDATE worker_tasks SET status = 'in_review' WHERE id = ?1")
            .bind(task_id)
            .execute(pool)
            .await
            .expect("force task into in_review");
    }

    async fn force_in_progress(pool: &sqlx::SqlitePool, task_id: Uuid) {
        sqlx::query("UPDATE worker_tasks SET status = 'in_progress' WHERE id = ?1")
            .bind(task_id)
            .execute(pool)
            .await
            .expect("force task into in_progress");
    }

    async fn append_review_task(
        db: &DBService,
        worker_id: Uuid,
        repo_id: Uuid,
        title: &str,
    ) -> WorkerTask {
        WorkerTask::append(
            &db.pool,
            worker_id,
            &CreateWorkerTask {
                repo_id,
                title: title.to_string(),
                prompt: "review".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .expect("append task")
    }

    #[tokio::test]
    async fn select_lru_reviewer_skips_candidate_at_capacity_cap() {
        // Sad path #1 from issue #302: the LRU-first candidate is at the
        // WORKER_MAX_IN_REVIEW cap while another reviewer has capacity.
        // The walk must skip the saturated one and land on the free one,
        // otherwise the task piles onto a worker that can't start it and
        // the PR waits while another reviewer sits idle.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "capacity-fallback-repo").await;
        let alpha = insert_reviewer(&db, "alpha").await;
        let bravo = insert_reviewer(&db, "bravo").await;

        // Cap = 1 so a single `in_review` task saturates a reviewer.
        let cap = 1i64;

        // Saturate alpha: append a task and flip it to `in_review` so
        // count_in_review(alpha) == cap.
        let alpha_task = WorkerTask::append(
            &db.pool,
            alpha.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "Review PR #1".to_string(),
                prompt: "review".to_string(),
                issue_number: Some(1),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        force_in_review(&db.pool, alpha_task.id).await;
        assert_eq!(
            WorkerTask::count_in_review(&db.pool, alpha.id)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            WorkerTask::count_in_review(&db.pool, bravo.id)
                .await
                .unwrap(),
            0
        );

        // Feed the candidates in alpha-first order (the scenario the bug
        // describes: LRU surfaces the saturated reviewer at the head). We
        // don't rely on `list_active_reviewers_lru`'s current ordering
        // here because it depends on subsecond timestamps of the seeded
        // task; the point of this test is the walk logic, not the query.
        let picked = select_lru_reviewer(&db.pool, vec![alpha.clone(), bravo.clone()], None, cap)
            .await
            .unwrap();
        assert_eq!(
            picked.map(|w| w.id),
            Some(bravo.id),
            "walk must skip the saturated LRU-first candidate and land on bravo",
        );
    }

    #[tokio::test]
    async fn select_lru_reviewer_returns_none_when_every_candidate_is_saturated() {
        // No-op path: every candidate is at the cap. `dispatch_review_task`
        // logs and skips instead of enqueuing on a saturated worker.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "all-saturated-repo").await;
        let alpha = insert_reviewer(&db, "alpha").await;
        let bravo = insert_reviewer(&db, "bravo").await;
        let cap = 1i64;

        for (reviewer_id, title) in [(alpha.id, "a"), (bravo.id, "b")] {
            let t = WorkerTask::append(
                &db.pool,
                reviewer_id,
                &CreateWorkerTask {
                    repo_id: repo.id,
                    title: title.to_string(),
                    prompt: "review".to_string(),
                    issue_number: None,
                    skills: Vec::new(),
                    issue_labels: Vec::new(),
                    source: worker_task::SOURCE_KANBAN.to_string(),
                    territory_globs: Vec::new(),
                },
            )
            .await
            .unwrap();
            force_in_review(&db.pool, t.id).await;
        }

        let picked = select_lru_reviewer(&db.pool, vec![alpha, bravo], None, cap)
            .await
            .unwrap();
        assert!(
            picked.is_none(),
            "walk must return None when every candidate is at cap",
        );
    }

    #[tokio::test]
    async fn select_lru_reviewer_combines_self_review_and_capacity_guards() {
        // LRU-first is the PR author (skipped by self-review guard).
        // Next candidate is at cap (skipped by capacity guard).
        // Third candidate is free → picked.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "combined-guards-repo").await;
        let author = insert_reviewer(&db, "author").await;
        let saturated = insert_reviewer(&db, "saturated").await;
        let free = insert_reviewer(&db, "free").await;
        let cap = 1i64;

        let saturated_task = WorkerTask::append(
            &db.pool,
            saturated.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "existing".to_string(),
                prompt: "review".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        force_in_review(&db.pool, saturated_task.id).await;

        let picked = select_lru_reviewer(
            &db.pool,
            vec![author.clone(), saturated.clone(), free.clone()],
            Some(author.id),
            cap,
        )
        .await
        .unwrap();
        assert_eq!(
            picked.map(|w| w.id),
            Some(free.id),
            "walk must skip author (self-review) and saturated (capacity), \
             then land on the free reviewer",
        );
    }

    #[tokio::test]
    async fn select_lru_reviewer_prefers_idle_over_busy_lru_first() {
        // Incidente PR #490 (08-ago-2026): the LRU-first reviewer was
        // mid-review (task in_progress) while another reviewer sat idle.
        // Reviewer tasks never hold an `in_review` slot, so the capacity
        // cap can't catch this — the busy-skip pass must.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "busy-skip-repo").await;
        let busy = insert_reviewer(&db, "busy").await;
        let idle = insert_reviewer(&db, "idle").await;

        let busy_task = append_review_task(&db, busy.id, repo.id, "Review PR #1").await;
        force_in_progress(&db.pool, busy_task.id).await;

        let picked = select_lru_reviewer(&db.pool, vec![busy.clone(), idle.clone()], None, 1)
            .await
            .unwrap();
        assert_eq!(
            picked.map(|w| w.id),
            Some(idle.id),
            "walk must skip the reviewer with a running task and pick the idle one",
        );
    }

    #[tokio::test]
    async fn select_lru_reviewer_queued_task_also_counts_as_busy() {
        // A task sitting in the reviewer's queue occupies the slot just
        // like a running one — the next dispatch must go to the idle
        // reviewer, not deepen the busy reviewer's queue.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "queued-busy-repo").await;
        let busy = insert_reviewer(&db, "busy").await;
        let idle = insert_reviewer(&db, "idle").await;

        // append leaves the task in `queued` — no status change needed.
        append_review_task(&db, busy.id, repo.id, "Review PR #1").await;

        let picked = select_lru_reviewer(&db.pool, vec![busy.clone(), idle.clone()], None, 1)
            .await
            .unwrap();
        assert_eq!(
            picked.map(|w| w.id),
            Some(idle.id),
            "a queued task must mark the reviewer as busy for the first pass",
        );
    }

    #[tokio::test]
    async fn select_lru_reviewer_falls_back_to_busy_when_all_busy() {
        // When every reviewer is occupied the walk must still enqueue on
        // the LRU-first eligible one instead of returning None — a review
        // waiting in a queue beats a review not dispatched at all.
        let db = setup_test_db().await;
        let (repo, _repo_tmp) = insert_repo(&db, "all-busy-repo").await;
        let alpha = insert_reviewer(&db, "alpha").await;
        let bravo = insert_reviewer(&db, "bravo").await;

        for (worker_id, title) in [(alpha.id, "Review PR #1"), (bravo.id, "Review PR #2")] {
            let t = append_review_task(&db, worker_id, repo.id, title).await;
            force_in_progress(&db.pool, t.id).await;
        }

        let picked = select_lru_reviewer(&db.pool, vec![alpha.clone(), bravo.clone()], None, 1)
            .await
            .unwrap();
        assert_eq!(
            picked.map(|w| w.id),
            Some(alpha.id),
            "with every reviewer busy the walk must fall back to the \
             LRU-first candidate, not skip dispatch",
        );
    }

    // --- infra-failure classification + round accounting ---

    /// Real payload from the 02-ago-2026 incident: the CLI died on an API
    /// 404 for the configured model. Must classify as infra with the real
    /// message surfaced.
    #[test]
    fn classify_cli_result_line_flags_model_404_as_infra() {
        let line = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"duration_ms":482,"num_turns":1,"result":"There's an issue with the selected model (fable). It may not exist or you may not have access to it. Run --model to pick a different model.","session_id":"s"}"#;
        let details = classify_cli_result_line(line).expect("result line must classify");
        assert!(details.infra, "API 404 is an infrastructure failure");
        assert!(
            details.message.contains("404") && details.message.contains("fable"),
            "card message must carry the real error: {}",
            details.message
        );
    }

    #[test]
    fn classify_cli_result_line_flags_rate_limit_text_as_infra() {
        let line =
            r#"{"type":"result","is_error":true,"result":"Rate limited. Please try again later."}"#;
        let details = classify_cli_result_line(line).expect("result line must classify");
        assert!(details.infra);
    }

    #[test]
    fn classify_cli_result_line_agent_error_is_not_infra() {
        let line = r#"{"type":"result","is_error":true,"result":"Execution stopped: the task could not be completed."}"#;
        let details = classify_cli_result_line(line).expect("result line must classify");
        assert!(
            !details.infra,
            "a genuine agent failure must consume a round as before"
        );
        assert!(details.message.contains("Execution stopped"));
    }

    #[test]
    fn classify_cli_result_line_skips_non_result_lines() {
        assert!(classify_cli_result_line(r#"{"type":"assistant","message":{}}"#).is_none());
        assert!(classify_cli_result_line("not json at all").is_none());
    }

    #[test]
    fn infra_retry_backoff_grows_and_caps() {
        assert_eq!(infra_retry_backoff(1).num_minutes(), 2);
        assert_eq!(infra_retry_backoff(2).num_minutes(), 4);
        assert_eq!(infra_retry_backoff(3).num_minutes(), 8);
        assert_eq!(infra_retry_backoff(4).num_minutes(), 16);
        assert_eq!(infra_retry_backoff(5).num_minutes(), 30);
        assert_eq!(infra_retry_backoff(20).num_minutes(), 30);
    }

    async fn append_reviewer_task_for_pr(
        db: &DBService,
        worker_id: Uuid,
        repo_id: Uuid,
        pr_number: i64,
    ) -> WorkerTask {
        WorkerTask::append(
            &db.pool,
            worker_id,
            &CreateWorkerTask {
                repo_id,
                title: format!("Review PR #{pr_number}"),
                prompt: "review".to_string(),
                issue_number: Some(pr_number),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .expect("append reviewer task")
    }

    /// Stamp a deterministic `created_at` so ordering-sensitive queries are
    /// not at the mercy of sub-second insert timing.
    async fn stamp_created_at(pool: &SqlitePool, task_id: Uuid, seconds_offset: i64) {
        let base = chrono::Utc.with_ymd_and_hms(2026, 8, 2, 12, 0, 0).unwrap();
        sqlx::query("UPDATE worker_tasks SET created_at = ?1 WHERE id = ?2")
            .bind(base + chrono::Duration::seconds(seconds_offset))
            .bind(task_id)
            .execute(pool)
            .await
            .expect("stamp created_at");
    }

    #[tokio::test]
    async fn infra_failed_tasks_do_not_consume_review_rounds() {
        // The 02-ago-2026 incident: 3 dispatches all died on an API 404
        // within minutes and burned the PR's whole round budget. With the
        // kind recorded, only real rounds count.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "rounds-repo").await;
        let reviewer = insert_reviewer(&db, "atlas").await;
        let pr = 373i64;

        for i in 0..3 {
            let task = append_reviewer_task_for_pr(&db, reviewer.id, repo.id, pr).await;
            stamp_created_at(&db.pool, task.id, i).await;
            WorkerTask::set_failed_with_kind(
                &db.pool,
                task.id,
                "Error de API (404): modelo no disponible",
                Some(worker_task::FAILURE_KIND_INFRA),
            )
            .await
            .unwrap();
        }

        assert_eq!(
            WorkerTask::count_reviewer_tasks_for_pr(&db.pool, pr, repo.id)
                .await
                .unwrap(),
            0,
            "infra failures must not burn review rounds"
        );
        assert_eq!(
            WorkerTask::count_trailing_infra_failures_for_pr(&db.pool, pr, repo.id)
                .await
                .unwrap(),
            3,
            "all three failures are consecutive (trailing)"
        );

        // A genuine agent failure still consumes a round and resets the
        // trailing-infra counter.
        let real = append_reviewer_task_for_pr(&db, reviewer.id, repo.id, pr).await;
        stamp_created_at(&db.pool, real.id, 10).await;
        WorkerTask::set_failed(&db.pool, real.id, "El agente terminó con error")
            .await
            .unwrap();

        assert_eq!(
            WorkerTask::count_reviewer_tasks_for_pr(&db.pool, pr, repo.id)
                .await
                .unwrap(),
            1,
            "agent failures keep consuming rounds"
        );
        assert_eq!(
            WorkerTask::count_trailing_infra_failures_for_pr(&db.pool, pr, repo.id)
                .await
                .unwrap(),
            0,
            "a task that really ran resets the consecutive-infra counter"
        );
    }

    #[tokio::test]
    async fn requeue_after_infra_failure_clears_kind_and_reason() {
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "requeue-repo").await;
        let reviewer = insert_reviewer(&db, "chewax").await;
        let task = append_reviewer_task_for_pr(&db, reviewer.id, repo.id, 374).await;

        WorkerTask::set_failed_with_kind(
            &db.pool,
            task.id,
            "Error de API (429): rate limited",
            Some(worker_task::FAILURE_KIND_INFRA),
        )
        .await
        .unwrap();
        assert_eq!(
            WorkerTask::count_trailing_infra_failures_for_pr(&db.pool, 374, repo.id)
                .await
                .unwrap(),
            1
        );

        // Manual retry from the UI re-queues the task: it starts clean.
        let requeued = WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_QUEUED)
            .await
            .unwrap();
        assert_eq!(requeued.failure_reason, None);
        assert_eq!(
            WorkerTask::count_trailing_infra_failures_for_pr(&db.pool, 374, repo.id)
                .await
                .unwrap(),
            0,
            "re-queued task no longer counts as an infra failure"
        );
    }

    #[test]
    fn pick_worker_model_respects_the_agent() {
        let claude = vec!["opus".to_string(), "sonnet".to_string()];
        let codex = vec!["gpt-5-codex".to_string()];
        // Offered model passes through.
        assert_eq!(
            pick_worker_model(
                BaseCodingAgent::ClaudeCode,
                Some("sonnet"),
                None,
                Some(&claude)
            ),
            Some("sonnet".to_string())
        );
        // A model the agent does not offer degrades to the agent default.
        assert_eq!(
            pick_worker_model(BaseCodingAgent::Codex, Some("opus"), None, Some(&codex)),
            None
        );
        // Unknown catalog: trust the stored model.
        assert_eq!(
            pick_worker_model(BaseCodingAgent::Codex, Some("gpt-5"), None, None),
            Some("gpt-5".to_string())
        );
        // Infra fallback applies to Claude only.
        assert_eq!(
            pick_worker_model(
                BaseCodingAgent::ClaudeCode,
                Some("fable"),
                Some(INFRA_FALLBACK_MODEL),
                Some(&claude)
            ),
            Some(INFRA_FALLBACK_MODEL.to_string())
        );
        assert_eq!(
            pick_worker_model(
                BaseCodingAgent::Codex,
                Some("gpt-5-codex"),
                Some(INFRA_FALLBACK_MODEL),
                Some(&codex)
            ),
            None
        );
        assert_eq!(
            pick_worker_model(BaseCodingAgent::Gemini, None, None, None),
            None
        );
    }

    #[tokio::test]
    async fn model_override_roundtrip() {
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "override-repo").await;
        let reviewer = insert_reviewer(&db, "solo").await;
        let task = append_reviewer_task_for_pr(&db, reviewer.id, repo.id, 375).await;

        assert_eq!(
            WorkerTask::model_override(&db.pool, task.id).await.unwrap(),
            None
        );
        WorkerTask::set_model_override(&db.pool, task.id, INFRA_FALLBACK_MODEL)
            .await
            .unwrap();
        assert_eq!(
            WorkerTask::model_override(&db.pool, task.id).await.unwrap(),
            Some(INFRA_FALLBACK_MODEL.to_string())
        );
    }

    #[tokio::test]
    async fn prepend_review_fix_jumps_the_queue() {
        // A changes-requested PR blocks an in_review slot, so its fix must
        // run before any queued feature work — not behind it (the PR #373
        // incident: the fix sat at the back of the queue for a day).
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "prepend-repo").await;
        let author = insert_worker(&db, "author").await;

        for title in ["feature A", "feature B"] {
            WorkerTask::append(
                &db.pool,
                author.id,
                &CreateWorkerTask {
                    repo_id: repo.id,
                    title: title.to_string(),
                    prompt: "build".to_string(),
                    issue_number: None,
                    skills: Vec::new(),
                    issue_labels: Vec::new(),
                    source: worker_task::SOURCE_KANBAN.to_string(),
                    territory_globs: Vec::new(),
                },
            )
            .await
            .unwrap();
        }

        let fix = WorkerTask::prepend_review_fix(
            &db.pool,
            author.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "Atendé el review del PR #373".to_string(),
                prompt: "fix".to_string(),
                issue_number: Some(373),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        let next = WorkerTask::find_next_queued(&db.pool, author.id)
            .await
            .unwrap()
            .expect("queue is not empty");
        assert_eq!(next.id, fix.id, "the fix must be first in the queue");
        assert_eq!(
            WorkerTask::kind(&db.pool, fix.id).await.unwrap().as_deref(),
            Some(worker_task::KIND_REVIEW_FIX)
        );
    }

    #[tokio::test]
    async fn pending_review_fix_guard_blocks_duplicates_until_terminal() {
        // Redundant review rounds on an unchanged head must not multiply
        // into redundant fix tasks: while one remediation is pending for a
        // PR, dispatch is a no-op. Once it reaches a terminal state, a new
        // round may dispatch a fresh one.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "pending-fix-repo").await;
        let author = insert_worker(&db, "author").await;

        // A regular task referencing the same PR number must NOT trip the
        // guard — only kind='review_fix' counts.
        WorkerTask::append(
            &db.pool,
            author.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "feature that mentions the PR".to_string(),
                prompt: "build".to_string(),
                issue_number: Some(373),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        assert!(
            WorkerTask::find_pending_review_fix_for_pr(&db.pool, 373, repo.id)
                .await
                .unwrap()
                .is_none()
        );

        let fix = WorkerTask::prepend_review_fix(
            &db.pool,
            author.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "Atendé el review del PR #373".to_string(),
                prompt: "fix".to_string(),
                issue_number: Some(373),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            WorkerTask::find_pending_review_fix_for_pr(&db.pool, 373, repo.id)
                .await
                .unwrap()
                .map(|t| t.id),
            Some(fix.id),
            "a queued review_fix blocks a second dispatch"
        );

        WorkerTask::set_status(&db.pool, fix.id, worker_task::STATUS_DONE)
            .await
            .unwrap();
        assert!(
            WorkerTask::find_pending_review_fix_for_pr(&db.pool, 373, repo.id)
                .await
                .unwrap()
                .is_none(),
            "a completed fix no longer blocks the next round's remediation"
        );
    }

    #[tokio::test]
    async fn merged_pr_sweep_closes_orphaned_review_fix_tasks() {
        // A review-fix task lives in its own workspace, so `on_pr_merged`
        // (which reconciles the PR's primary workspace) never closes it: the
        // card sits in_review forever with a MERGED badge. The sweep must
        // close exactly those — and leave fixes for still-open PRs alone.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "sweep-repo").await;
        let author = insert_worker(&db, "author").await;

        let mk_fix = |pr_number: i64| CreateWorkerTask {
            repo_id: repo.id,
            title: format!("Atendé el review del PR #{pr_number} — ronda 1"),
            prompt: "fix".to_string(),
            issue_number: Some(pr_number),
            skills: Vec::new(),
            issue_labels: Vec::new(),
            source: worker_task::SOURCE_KANBAN.to_string(),
            territory_globs: Vec::new(),
        };

        let merged_fix = WorkerTask::prepend_review_fix(&db.pool, author.id, &mk_fix(402))
            .await
            .unwrap();
        force_in_review(&db.pool, merged_fix.id).await;
        PullRequest::create(
            &db.pool,
            None,
            Some(repo.id),
            "https://github.com/o/r/pull/402",
            402,
            "main",
        )
        .await
        .unwrap();
        sqlx::query("UPDATE pull_requests SET pr_status = 'merged' WHERE pr_number = 402")
            .execute(&db.pool)
            .await
            .unwrap();

        let open_fix = WorkerTask::prepend_review_fix(&db.pool, author.id, &mk_fix(403))
            .await
            .unwrap();
        force_in_review(&db.pool, open_fix.id).await;
        PullRequest::create(
            &db.pool,
            None,
            Some(repo.id),
            "https://github.com/o/r/pull/403",
            403,
            "main",
        )
        .await
        .unwrap();

        let completed = WorkerTask::complete_review_fix_tasks_for_merged_prs(&db.pool)
            .await
            .unwrap();
        assert_eq!(completed, vec![(merged_fix.id, author.id)]);
        assert_eq!(
            WorkerTask::find_by_id(&db.pool, merged_fix.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            worker_task::STATUS_DONE
        );
        assert_eq!(
            WorkerTask::find_by_id(&db.pool, open_fix.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            worker_task::STATUS_IN_REVIEW,
            "a fix for a still-open PR must not be touched"
        );

        // Idempotent: a second sweep finds nothing.
        assert!(
            WorkerTask::complete_review_fix_tasks_for_merged_prs(&db.pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn default_max_in_review_serializes_worker_to_one_ticket() {
        // #472: a worker becomes idle only when its PR merges. If this ever
        // goes above 1, the state-machine rule is silently relaxed and workers
        // start piling up open tickets while their earlier PRs still wait for
        // review — the exact regression this test guards against.
        assert_eq!(
            DEFAULT_MAX_IN_REVIEW, 1,
            "raising the default reopens the serial-per-worker contract from #472"
        );
    }

    #[tokio::test]
    async fn cap_blocks_new_ticket_when_worker_has_in_review_task() {
        // Serial-per-worker (issue #472): with the default cap of 1, a worker
        // that already has an in_review task cannot take a fresh queued ticket
        // — the helper must return InReviewCapReached and record the hit.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "serial-block-repo").await;
        let worker = insert_worker(&db, "serial-worker").await;

        let occupying = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "already merged-ish".to_string(),
                prompt: "occupy the slot".to_string(),
                issue_number: Some(500),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        force_in_review(&db.pool, occupying.id).await;

        // Fresh feature ticket queued behind the in_review one.
        WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "next feature".to_string(),
                prompt: "build".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        let result = resolve_next_takeable_task(&db.pool, worker.id, 1).await;
        assert!(
            matches!(result, Err(StartError::InReviewCapReached(1))),
            "expected InReviewCapReached(1), got {result:?}"
        );

        // The blocked queued task is a real upsell signal — hit is recorded.
        assert_eq!(
            PlanCapHit::count_today(&db.pool).await.unwrap(),
            1,
            "blocked queued task must record a plan-cap-hit for the day"
        );
    }

    #[tokio::test]
    async fn cap_allows_review_fix_even_when_worker_is_at_cap() {
        // Review-fix exemption (#386): a worker whose PR came back with
        // changes-requested keeps the slot occupied, but its drain task
        // (the review_fix) must still run — otherwise the fix waits for a
        // slot that only opens by merging the PR the fix is supposed to fix.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "serial-fix-repo").await;
        let worker = insert_worker(&db, "fix-worker").await;

        let occupying = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "PR #501 awaiting review".to_string(),
                prompt: "the original ticket".to_string(),
                issue_number: Some(501),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        force_in_review(&db.pool, occupying.id).await;

        let fix = WorkerTask::prepend_review_fix(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "Atendé el review del PR #501".to_string(),
                prompt: "fix the review comments".to_string(),
                issue_number: Some(501),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        let taken = resolve_next_takeable_task(&db.pool, worker.id, 1)
            .await
            .expect("review_fix must be exempt from the in-review cap");
        assert_eq!(
            taken.id, fix.id,
            "the exempt review_fix must be the task offered next"
        );

        // Exempt take must NOT bump the plan-cap-hit counter — the worker
        // was not turned away, and this is not an upsell signal.
        assert_eq!(
            PlanCapHit::count_today(&db.pool).await.unwrap(),
            0,
            "review_fix exemption is not a cap hit"
        );
    }

    #[tokio::test]
    async fn cap_frees_the_worker_once_in_review_task_completes() {
        // Merging (or otherwise moving the in_review task to a terminal state)
        // frees the slot so the worker picks up the next queued ticket. This
        // is the "PR mergea → worker toma el próximo" leg of the state
        // machine.
        let db = setup_test_db().await;
        let (repo, _tmp) = insert_repo(&db, "serial-free-repo").await;
        let worker = insert_worker(&db, "free-worker").await;

        let occupying = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "will merge".to_string(),
                prompt: "occupy".to_string(),
                issue_number: Some(502),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        force_in_review(&db.pool, occupying.id).await;

        let next = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "next up".to_string(),
                prompt: "build the next thing".to_string(),
                issue_number: None,
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        // Sanity: still blocked while the earlier task sits in_review.
        assert!(matches!(
            resolve_next_takeable_task(&db.pool, worker.id, 1).await,
            Err(StartError::InReviewCapReached(1))
        ));

        // PR merges → occupying task moves to `done` → slot frees up.
        WorkerTask::set_status(&db.pool, occupying.id, worker_task::STATUS_DONE)
            .await
            .unwrap();

        let taken = resolve_next_takeable_task(&db.pool, worker.id, 1)
            .await
            .expect("freed slot must allow taking the next queued task");
        assert_eq!(taken.id, next.id, "the worker must pick the queued ticket");
    }

    // -------- Issue #510: remediation summary comment --------

    /// Seed a repo backed by a real on-disk git repo with a GitHub `origin`,
    /// so `agent_actions_drain` can resolve `owner/repo` cleanly. Mirrors the
    /// helper in the `agent_actions_drain` tests: FKs are off in the pool so
    /// we only need the rows the code under test actually reads.
    async fn seed_repo_with_github_origin(db: &DBService, name: &str) -> (Repo, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().to_path_buf();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&path)
            .output()
            .expect("git init");
        std::process::Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/octo/repo.git",
            ])
            .current_dir(&path)
            .output()
            .expect("git remote add");
        let repo = Repo::find_or_create(&db.pool, &path, name)
            .await
            .expect("insert repo");
        (repo, tmp)
    }

    #[test]
    fn remediation_summary_body_uses_short_sha() {
        let body = build_remediation_summary_body("abc1234deadbeef567890");
        assert!(body.contains("abc1234"), "must include short SHA");
        assert!(
            !body.contains("abc1234deadbeef"),
            "must NOT leak the full SHA"
        );
        assert!(body.starts_with("Remediación completada en "));
    }

    /// Acceptance criterion (issue #510): al cerrar una remediación exitosa se
    /// crea exactamente una fila `agent_action` con `kind = "comment_pr"` para
    /// esa task, con el pr y el body correctos.
    #[tokio::test]
    async fn enqueue_remediation_summary_action_creates_one_comment_pr_row() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "dani").await;
        let (repo, _tmp) = insert_repo(&db, "sum-repo").await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "feature".to_string(),
                prompt: "ship".to_string(),
                issue_number: Some(510),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        let body = build_remediation_summary_body("cafef00ddeadbeef");
        enqueue_remediation_summary_action(&db.pool, task.id, repo.id, 42, &body)
            .await
            .expect("enqueue must succeed");

        let rows = AgentAction::find_by_task_id(&db.pool, task.id)
            .await
            .unwrap();
        let comment_rows: Vec<_> = rows.iter().filter(|r| r.kind == "comment_pr").collect();
        assert_eq!(
            comment_rows.len(),
            1,
            "exactly one comment_pr row must be created for the task"
        );
        let row = comment_rows[0];
        assert_eq!(row.status, agent_action::STATUS_PENDING);

        let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
        assert_eq!(payload["kind"], "comment_pr");
        assert_eq!(payload["pr"], 42);
        assert_eq!(payload["body"], body);
    }

    /// When agent-declared actions were already ingested (seq 0..N), the
    /// summary comment must take the NEXT free seq — never collide with an
    /// existing row (INSERT OR IGNORE would silently drop it).
    #[tokio::test]
    async fn enqueue_remediation_summary_action_picks_next_free_seq() {
        let db = setup_test_db().await;
        let worker = insert_worker(&db, "dani").await;
        let (repo, _tmp) = insert_repo(&db, "seq-repo").await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "t".to_string(),
                prompt: "p".to_string(),
                issue_number: Some(1),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();

        // Pretend the agent already declared two actions (seq 0 and 1).
        for seq in [0i64, 1] {
            AgentAction::create(
                &db.pool,
                &db::models::agent_action::CreateAgentAction {
                    task_id: task.id,
                    repo_id: repo.id,
                    seq,
                    kind: "comment_issue".to_string(),
                    payload: format!(r#"{{"kind":"comment_issue","issue":{seq},"body":"x"}}"#),
                },
            )
            .await
            .unwrap();
        }

        let row = enqueue_remediation_summary_action(
            &db.pool,
            task.id,
            repo.id,
            9,
            &build_remediation_summary_body("deadbee"),
        )
        .await
        .unwrap();
        assert_eq!(row.seq, 2, "summary must land on the next free seq");
    }

    /// Acceptance criterion (issue #510): si el drenaje del comment devuelve
    /// `failed > 0`, la task NO transiciona a `failed` — el push ya está en
    /// el PR y el comentario resumen es cosmético.
    #[tokio::test]
    async fn drain_remediation_summary_never_fails_task_on_definitive_failure() {
        use async_trait::async_trait;

        let db = setup_test_db().await;
        let worker = insert_worker(&db, "dani").await;
        let (repo, _tmp) = seed_repo_with_github_origin(&db, "drain-repo").await;
        let task = WorkerTask::append(
            &db.pool,
            worker.id,
            &CreateWorkerTask {
                repo_id: repo.id,
                title: "t".to_string(),
                prompt: "p".to_string(),
                issue_number: Some(1),
                skills: Vec::new(),
                issue_labels: Vec::new(),
                source: worker_task::SOURCE_KANBAN.to_string(),
                territory_globs: Vec::new(),
            },
        )
        .await
        .unwrap();
        // Get the task to in_review, the state a follow-up run finishes in.
        WorkerTask::set_status(&db.pool, task.id, worker_task::STATUS_IN_REVIEW)
            .await
            .unwrap();

        // Enqueue the summary action.
        enqueue_remediation_summary_action(
            &db.pool,
            task.id,
            repo.id,
            99,
            &build_remediation_summary_body("cafedad"),
        )
        .await
        .unwrap();

        // Fake executor that always fails definitively (simulates a closed PR
        // returning 404 — the sad path the issue calls out).
        struct AlwaysFail;
        #[async_trait]
        impl agent_actions_drain::ActionExecutor for AlwaysFail {
            async fn post_pr_comment(
                &self,
                _owner_repo: &str,
                _pr: i64,
                _body: &str,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                Err(agent_actions_drain::ExecutorFailure {
                    kind: agent_actions_drain::FailureKind::Definitive,
                    message: "HTTP 404: not found".into(),
                })
            }
            async fn post_issue_comment(
                &self,
                _owner_repo: &str,
                _issue: i64,
                _body: &str,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn create_milestone(
                &self,
                _owner_repo: &str,
                _title: &str,
                _description: &str,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn create_issue(
                &self,
                _owner_repo: &str,
                _title: &str,
                _body: &str,
                _labels: &[String],
                _milestone_number: Option<i64>,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn close_issue(
                &self,
                _owner_repo: &str,
                _issue: i64,
                _reason: &str,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn add_labels(
                &self,
                _owner_repo: &str,
                _issue: i64,
                _labels: &[String],
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn resolve_review_thread(
                &self,
                _owner_repo: &str,
                _pr_number: i64,
                _thread_id: &str,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
            async fn update_issue(
                &self,
                _owner_repo: &str,
                _issue: i64,
                _title: Option<&str>,
                _body: Option<&str>,
                _pat: Option<&str>,
            ) -> Result<agent_actions_drain::ExecutedAction, agent_actions_drain::ExecutorFailure>
            {
                unreachable!("summary comment only posts comment_pr")
            }
        }

        let cfg = Arc::new(RwLock::new(Config::default()));
        drain_remediation_summary_best_effort(&cfg, &db.pool, task.id, 99, &AlwaysFail).await;

        // Task must still be in_review — the summary comment is best-effort.
        let refreshed = WorkerTask::find_by_id(&db.pool, task.id)
            .await
            .unwrap()
            .expect("task still exists");
        assert_eq!(
            refreshed.status,
            worker_task::STATUS_IN_REVIEW,
            "drain failure must NOT flip the task to `failed`"
        );
        assert!(
            refreshed.failure_reason.is_none(),
            "no failure_reason must be recorded when the drain fails"
        );

        // The row itself should be marked `failed` in the ledger — the caller
        // just doesn't propagate that up to the task.
        let rows = AgentAction::find_by_task_id(&db.pool, task.id)
            .await
            .unwrap();
        let summary = rows
            .iter()
            .find(|r| r.kind == "comment_pr")
            .expect("summary row exists");
        assert_eq!(summary.status, agent_action::STATUS_FAILED);
    }
}
