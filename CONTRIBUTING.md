# Contributing to fluke

Thanks for your interest in fluke. Bug reports, ideas, docs fixes and code are all welcome.

By participating you agree to follow the [Code of Conduct](CODE-OF-CONDUCT.md).

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, what happened, your OS, and the fluke version (shown in the status bar).
- **Features**: open an issue to discuss the idea before writing a large change. Small fixes can go straight to a pull request.
- **Security issues**: do not open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Rust (toolchain pinned in `rust-toolchain.toml`), Node.js 20+, pnpm 10.

```bash
pnpm install
pnpm run dev        # backend (cargo watch) + web frontend (Vite)
pnpm run tauri:dev  # same, inside the desktop shell
```

Repository conventions (structure, shared Rust/TypeScript types, migrations, PR markers) are in [AGENTS.md](AGENTS.md). Read it before your first PR; it applies to humans and coding agents alike.

## Pull requests

1. Fork the repo and create a branch from `main` (`fix/...`, `feat/...`, `docs/...`).
2. Keep the PR focused on one change. Unrelated refactors go in separate PRs.
3. Run before pushing:
   ```bash
   pnpm run format
   pnpm run lint
   pnpm run check
   cargo test --workspace
   ```
4. If you changed Rust types exported to TypeScript, regenerate them with `pnpm run generate-types` and include `[types-regen]` in the PR description. If you changed `Cargo.lock`, include `[lockfile]`.
5. Describe *what* changed and *why*. Screenshots or a short clip help for UI changes.
6. A maintainer reviews every PR. CI must be green before merging.

## Coding style

- **Rust**: `rustfmt` (config in `rustfmt.toml`), `snake_case` modules and functions, `PascalCase` types, imports grouped by crate. Unit tests next to the code with `#[cfg(test)]`.
- **TypeScript/React**: ESLint + Prettier (2 spaces, single quotes, 80 columns). `PascalCase` components, `camelCase` variables and functions, `kebab-case` file names.
- Keep functions small, avoid speculative abstractions, and never edit generated files (`shared/types.ts`, `shared/remote-types.ts`) by hand.
- Never commit secrets. Use `.env` for local configuration.

## Commit messages

Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), subject under 72 characters, body explaining the *why* when it is not obvious.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
