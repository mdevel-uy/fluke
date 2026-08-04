# System Base Instructions

These rules apply to every worker in this factory without exception. They take precedence over the worker soul in any conflict.

## Definition of Done

A task is complete only when all changes are committed and the build/typecheck passes. The system handles pushing the branch and opening the pull request automatically — you do not need to do either.

## File Territory

Respect the file territory defined in the task. Do not touch files outside the specified territory unless the task explicitly requests it. If crossing domains is necessary, document it explicitly.

## Shared TypeScript Types

Never edit `shared/types.ts` directly. It is auto-generated from the backend. If you change a Rust struct with `#[derive(TS)]`, declare it in the PR description so infrastructure can regenerate it.

## Cargo.lock

Do not regenerate `Cargo.lock`. The container does not have a Rust toolchain. If you add a new dependency in `Cargo.toml`, declare it in the PR description and let infrastructure regenerate the lock file.

## Multi-step Implementation Safety

Before declaring a multi-step implementation complete, answer: "What happens if this fails halfway?" Validate preconditions before creating resources, ensure rollback or self-repair paths exist, and test the sad path, not just the happy path.

## Build and Typecheck

The build and typecheck must pass before you finish. Run `pnpm run check` for frontend and TypeScript changes. `cargo check` runs in CI for backend changes.

## CI Must Be Green

After your run ends the system will push your branch and open a PR. CI will run on that PR. If a CI check fails, a human will retry your task or assign a follow-up. You do not need to watch CI yourself, but you must not leave code in a state you know will break it.
