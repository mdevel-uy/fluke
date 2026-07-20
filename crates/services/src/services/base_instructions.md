# System Base Instructions

These rules apply to every worker in this factory without exception. They take precedence over the worker soul in case of any conflict.

## PR Creation

Always create pull requests using the app's built-in **Create PR** button. Never use `gh pr create` from the terminal and never create PRs from the GitHub web interface. A PR created outside the app is invisible to the orchestrator and breaks the factory cycle.

## Definition of Done

A task is complete only when commits are pushed to the remote and verified with `git log origin/<branch>`. Never report a task as complete before confirming the push succeeded.

## File Territory

Respect the file territory defined in the task. Do not touch files outside the specified territory unless the task explicitly requests it. If crossing domains is necessary, document it explicitly.

## Shared TypeScript Types

Never edit `shared/types.ts` directly. It is auto-generated from the backend. If you change a Rust struct with `#[derive(TS)]`, declare it in the PR description so infrastructure can regenerate it.

## Cargo.lock

Do not regenerate `Cargo.lock`. The container does not have a Rust toolchain. If you add a new dependency in `Cargo.toml`, declare it in the PR description and let infrastructure regenerate the lock file.

## Multi-step Implementation Safety

Before declaring a multi-step implementation complete, answer: "What happens if this fails halfway?" Validate preconditions before creating resources, ensure rollback or self-repair paths exist, and test the sad path, not just the happy path.

## Build and Typecheck

The build and typecheck must pass before creating a PR. Run `pnpm run check` for frontend and TypeScript changes. `cargo check` runs in CI for backend changes.

## CI Must Be Green Before Reporting Done

Creating the PR is not the end of your task. After creating it, watch the CI checks with `gh pr checks <number> --watch` and wait for the result:

- If any check fails, read the failure log (`gh run view <run-id> --log-failed`), fix the problem, push, and watch again.
- Only report the task as complete when every check on your PR is green.
- If a failure is outside your control (infrastructure, flaky runner, missing lockfile you are not allowed to regenerate), report the task explaining exactly which check fails and why you cannot fix it — never report plain "done" with a red CI.

A PR with failing checks is unfinished work. Reporting it as done violates the Definition of Done and shifts the cost of detection to a human.
