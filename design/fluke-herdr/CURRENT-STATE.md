# Fluke Console — checkpoint

Updated: 2026-10-08. This is the short starting point for the next review.

## Product we are building

Own native Go terminal application, aimed at personal use on Linux/Omarchy.
Windows is the current development and native test host. Lightweight, responsive
and reliable; recognizable retro/neon design is a core requirement.

A project is a repository with tasks and sessions. The person talks mainly to
the orchestrator, agrees on a goal and scope, then lets it organize and dispatch
workers within the global concurrency limit. One worker owns each task through
analysis, implementation and verification. Parallel workers handle different
tasks. No worker profiles. Product/scope changes and integration remain human
decisions. The person can also talk directly to any worker.

Herdr and Tuios are research references, not embedded tools. Original Fluke
provided references for GitHub configuration; this runtime is independent.

## Approved visual direction

Keep the established cyan/magenta/lime terminal workspace. For the introduction,
use the original whale-tail silhouette and the same smaller pixel wordmark used
inside the application. The tail balances gently and uses mixed ASCII density
(`· . : + * # @`); the wordmark has a restrained moving reflection. No giant
uppercase replacement font or rainbow cycling. Enter advances immediately.
Setup uses brief single-cell title corruption and decorative border interference,
without a pause shortcut or game wording; input and authorization data stay intact.
Reference preview: `previews/intro-original-wordmark.gif` (predates these effects).
Actual terminal capture: `../../tools/fluke-console-go/captures/go-setup-motion.gif`.

## Implemented

- First-run stages: local harness discovery, orchestrator/model/sign-in,
  optional GitHub connection, existing repository selection, worker limit,
  readiness summary. Progress and choices persist; stale asynchronous results
  cannot advance a different step. English default; Spanish selectable.
- Discovery recognizes 24 CLI commands, identifies installer launchers without
  running them, considers Omarchy's existing default, and reads installed model
  catalogs/aliases. Codex and Claude have working runtime adapters; other
  detected harnesses remain unsupported. Model access is checked on session use.
- F1–F7 navigation, conversation, goals/tasks/dependencies, global worker limit,
  owned worktrees/branches, direct sessions and terminal window management.
- Durable concise agent reports, decisions, same-worker corrections, task and
  project pause, native session recovery, scrollback and copy paths.
- Worker message editor (F2 m / F3 Ctrl+X m), shared durable instructions,
  append-only decision amendments with global source numbers, serialized prompts
  and separate message files. A ready report must acknowledge its instruction.
- Global attention links to the correct project/task/session, including deliveries
  awaiting review and off-focus native prompts. Routine worker transcript is omitted.
- Scope holds: changing a goal pauses older tasks; explicit `:adopt ID` keeps an
  existing task under the new goal. Edited briefs/goal specs stop affected work
  and preserve files. No automatic semantic interpretation of edited plans.
- GitHub setup/device flow, issue reading/import, PR preview/title/body editing,
  explicit draft publication or existing-PR update, with durable recovery guards.
- Read-only follow-up of owned published PRs: checks, review and merge state,
  bounded serialized queries, stale-publication guards and retained status on error.
  Status enters orchestration context; remote merge does not release local dependencies.
- Human acceptance records the reviewed tree. Local integration previews and
  verifies the expected merge. Dependent work waits for verified integration;
  a clean older worktree can advance without discarding its work.

Code: `../../tools/fluke-console-go`. English usage: `GETTING-STARTED.md`.
Detailed verification: `QA-2026-10-07.md` in that module.

## Verification at this checkpoint

The latest setup effects/copy changes are source-only: regression tests were
updated but not run, and the Windows executable/captures have not been rebuilt.
The verification below describes the earlier build.

- Actual Windows ConPTY flow passed configuration, F1–F7, two workers, review,
  durable worker-message editing/canceling, editable PR publication against a
  simulated GitHub CLI, and local integration.
- Native English first-run flow passed, including the earlier animation/pause, persisted
  choices, launcher switches and reopening without repeating setup.
- Real Codex orchestration passed isolated worker delivery, external file
  verification and a concise human-review update in English (99.490 s).
  Earlier real Codex/Claude recovery and Claude correction flows also passed.
- Real Codex intervention passed answer amendment and a subsequent direct message
  in the same native session, with external output verification and acknowledgments
  of both instruction numbers (141.538 s).
- Scope, spec, dependency, translation and recovery regressions have targeted
  tests. A Windows reader/replacement collision now has a reproducing test:
  temporary readers are retried briefly; permanently locked files stay intact.
- One short Windows sample with two idle PTYs measured 59.5 MiB working set
  and 3.791% of one CPU core over 5.36 s, excluding the worker processes and
  orchestrator. This is not an active-agent load or Linux measurement.
- Linux amd64/arm64 and macOS arm64 binaries compile without CGO. Native operation
  on those systems is not verified.
- The complete Go suite passed on Windows (456.394 s), including the
  launcher and simulated GitHub publication flow. This does not verify native
  Linux/Omarchy operation or establish release readiness.

## Known work remaining

1. Native Linux/Omarchy acceptance: terminal behavior, mouse/clipboard, process
   trees, authentication, worktree lifecycle and restart/recovery on the target.
2. Direct native CLI entry remains a terminal channel; use Fluke's worker message
   editor for durable instructions and plan coordination. Corrections to scope/task
   proposals or integrated/published work require a new proposal/follow-up task.
3. Semantic plan/spec reconciliation. Current detection deliberately holds work
   and requests human review rather than inferring newly authorized scope.
4. Real GitHub device authorization/publication/update verification; broader issue
   lifecycle synchronization and remote squash/cherry-pick reconciliation.
   PR status follow-up exists; current write-flow checks use simulated CLI.
5. Performance and soak testing with active agents. Binary size or splash render
   benchmarks are not measurements of production CPU/RAM or prolonged stability.
6. Additional harness adapters, advanced VT behavior, user-terminal copy checks,
   distribution/update/install experience, and repository/worktree cleanup policy.

Next review should use the current source and this checkpoint, distinguish
missing behavior from unverified behavior, and rank the smallest useful next
increments. Do not reopen settled Go/profile/embedding/design decisions.


## Current verification increment

The first fresh review identified worker-to-orchestrator intervention, decision
correction, attention routing and PR follow-up gaps. Those now have implementations
and targeted tests. Further review found and fixed overlapping answer-file writes;
each dispatch has a separate immutable message file and resets the idle debounce.

The first real Codex correction exposed unsubmitted multiline input. Native
bracketed-paste mode is now tracked from complete VT sequences and used for pasted
messages; automatic notifications are concise. The real rerun and complete Go
suite passed. Final panel wrapping and command-help changes passed their focused
attention/language regression checks (0.159 s).
The final executable also passed the native launcher/two-worker/publication/
integration and English first-run confirmation (45.321 s); terminal captures
were refreshed from the test repositories.

Omarchy testing is explicitly deferred: the user's installation is on this same
machine and requires rebooting. Continue the other work without requiring a reboot.
