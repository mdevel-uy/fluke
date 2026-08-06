<p align="center"><strong>Vibe Kanban — Local Edition</strong></p>
<p align="center">A lean, self-hosted fork of Vibe Kanban maintained by <a href="https://github.com/mdevel-uy">mdevel-uy</a>.</p>

## About this fork

Bloop AI [sunset the original Vibe Kanban](https://www.vibekanban.com/blog/shutdown) in April 2026. This fork continues the project as a **local-first, self-hosted edition**: no cloud backend, no login gate, no telemetry surface. Everything runs on your machine, against repositories and coding agents you already control.

The upstream product was a hybrid of a local desktop app and a hosted cloud service. The Local Edition drops the cloud half and doubles down on the parts that work offline: a kanban to plan work, workspaces where coding agents run, diffs to review, and PRs to merge.

- **What it is:** the parts of Vibe Kanban you can run yourself, kept alive and moving.
- **What it is not:** a drop-in replacement for the hosted Vibe Kanban Cloud.

Tracked as branch `mdev` on top of [`BloopAI/vibe-kanban`](https://github.com/BloopAI/vibe-kanban) `main`. Upstream fixes are merged in periodically; fork-specific work lives on top.

## What this fork adds on top of upstream

- **PR CI.** GitHub Actions workflow runs frontend and backend checks on every pull request against this fork.
- **GitHub connection from Settings.** Authenticate the container's `gh` CLI via device flow directly from the UI — no manual token juggling.
- **Add repositories from GitHub.** The "Add Repository" dialog can list your GitHub repos and clone one into the container in a single step.
- **Per-repo Issues view.** GitHub issues are synced and persisted per repository, browsable inside the app.
- **Assign to agent.** From the Issues view, hand an open issue to a coding agent as a new workspace, prefilled with the issue context.
- **Cloud/login UI removed.** Sign-in gate, account menu, Discord link, and star badge are gone from the local build.

### Roadmap (in progress)

- **Persistent workers with "soul."** Long-lived agent workers that keep context and preferences across tasks.
- **Sprint board.** A kanban view scoped to a sprint, not just a backlog.
- **Team-lead reviewer.** An automated reviewer agent that inspects agent-authored PRs before a human sees them.

## Running it

The supported deployment for this fork is **Docker**, built from the `Dockerfile` at the root of `vibe-kanban/`.

### Prerequisites inside the container

The image ships the server binary and the frontend, but the coding-agent runtime and GitHub CLI have to be available and authenticated at runtime:

- A **coding agent CLI** you want to drive (e.g. Claude Code, Codex, Gemini CLI). It must be installed and logged in inside the container.
- The **`gh` CLI**, authenticated — either interactively via the in-app device flow, or by mounting a pre-authenticated `~/.config/gh` from the host.

The simplest pattern is to extend the base image, install your agent CLI, and mount host credentials into the container.

### Build and run

```bash
# From the vibe-kanban/ directory
docker build -t vibe-kanban-local .

docker run --rm -it \
  -p 3000:3000 \
  -v "$PWD/repos:/repos" \
  vibe-kanban-local
```

Then open <http://localhost:3000>.

`/repos` is where cloned repositories land. Mount it as a volume so clones survive container restarts.

### Environment

Runtime environment variables inherited from upstream still apply. The ones most relevant to a local self-hosted deployment:

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address for the server. |
| `PORT` | `3000` | Server port. |
| `VK_ALLOWED_ORIGINS` | unset | Comma-separated list of allowed origins when running behind a reverse proxy or on a custom domain. Required to avoid 403 responses. |
| `DISABLE_WORKTREE_CLEANUP` | unset | Disable git worktree cleanup for debugging. |

Cloud-oriented variables (`VK_SHARED_API_BASE`, `VK_SHARED_RELAY_API_BASE`, `VK_TUNNEL`, `POSTHOG_*`) are intentionally not needed. Leave them unset.

## Relation to upstream

- Upstream: [`BloopAI/vibe-kanban`](https://github.com/BloopAI/vibe-kanban), sunset in April 2026.
- Fork: [`mdevel-uy/vibe-kanban`](https://github.com/mdevel-uy/vibe-kanban), branch `mdev`.
- Merges from upstream `main` are still welcome for fixes that predate the shutdown. New product direction — persistent workers, sprint board, team-lead reviewer — is fork-only.

## Development

Development instructions from upstream still apply for anyone hacking on the code directly (Rust + Node/pnpm workspace, `pnpm run dev`, etc.). See [`AGENTS.md`](AGENTS.md) for the repository guidelines used by contributors and coding agents.

## Support

Open issues and discussions on the [fork's repository](https://github.com/mdevel-uy/vibe-kanban). Upstream issue trackers and Discord are no longer monitored.
