# Fluke Console

A terminal workspace for your project: agree on a goal, let Fluke coordinate
workers, and review their changes before merging. Fluke owns its interface and
sessions. Herdr and Tuios informed the research; neither is embedded.

Gentle Shell also informs the current settings and navigation. **Alt+K** opens
a searchable list of views and settings; **Ctrl+P** finds projects/workers and
**Ctrl+K** opens the command editor. In **F5**, click Agent, Connection, GitHub,
Theme or Text, or use **Ctrl+Left/Right**. Connection separates CLI availability
from account authentication: **Ctrl+L** opens native sign-in, **Ctrl+R** checks
status. Theme includes the optional Gentle palette; Text explains host terminal
font settings. These source changes still need external build and validation.

## Linux / Omarchy

### Build from GitHub

The repository is private; cloning requires an account with access. Install
Git and Go 1.26.6 or newer, then run:

```sh
git clone --branch codex/fluke-console-go https://github.com/mdevel-uy/fluke.git
cd fluke/tools/fluke-console-go
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o fluke .
./fluke --lang es
```

This builds only the Go console, without the web app or Rust backend. To use
agents, install and authenticate Codex CLI or Claude Code. GitHub CLI (`gh`)
is optional. Go is required to build, but not to run the resulting executable.

### Install a prebuilt executable

Install the Linux executable as `fluke` in a directory on your PATH:

```sh
mkdir -p ~/.local/bin
install -m755 ./fluke-console-linux-amd64 ~/.local/bin/fluke
fluke
# Or open one repository directly:
fluke --repo ~/your-project
```

Use the arm64 executable on an ARM machine. If `~/.local/bin` is not on PATH,
run `~/.local/bin/fluke` directly. Git is required; GitHub CLI (`gh`) is optional.
Use a terminal with Unicode and color support, such as Omarchy's terminal.
The builds do not require a separate Go installation or CGO at runtime.

Native Linux/macOS execution is still awaiting verification. These binaries
are development builds, not a release tested on Omarchy.

## First launch

Fluke starts with its animated whale-tail logo and original pixel wordmark.
Enter starts setup immediately. Ctrl+L switches English and
Spanish. Discovery runs locally without installing tools or using inference.
Brief text corruption and signal interference affect decorative titles and
borders throughout setup; choices, input fields and authorization codes stay intact.

1. **Harnesses:** select an installed CLI. Fluke recognizes 24 known commands;
   Codex and Claude Code currently have working session/state adapters.
   Other detected tools are clearly marked as unsupported.
2. **Orchestrator:** choose a model from the local CLI catalog or its aliases.
   Recommendations come from that installation rather than pinned model IDs.
   Keep the harness's default or enter an ID manually when no catalog exists.
   Ctrl+L opens native sign-in; R checks again when you return. Remote model
   access is only confirmed when a session starts.
3. **GitHub:** connect with the device code, use an existing account, or continue
   locally. Connecting requires `gh`; provider credentials stay with the CLI.
4. **First project (optional):** select an existing Git repository, or leave
   the path blank to start with the global overview. Paths with spaces and `~`
   work. Project selection does not change existing files.
5. **Workers:** set the global concurrency limit, shared across all projects.
   Each worker owns one task; multiple workers handle different tasks.
6. **Ready:** enter Fluke and describe your goal. No model session starts until
   you send the first message.

Setup saves progress as you advance. Esc goes back; Ctrl+Q exits. Run
`fluke --setup` to revisit setup, or `fluke --lang es` to select Spanish.
With no `--repo`, Fluke opens the global overview after setup.

## Create a project from scratch

Press **F1 → N**, enter a name, then press Enter to edit the destination folder.
Choose a folder that does not exist yet and press Enter again. Fluke creates
the folder, initializes Git on `main` and makes an empty initial commit. It
then opens the project's chat: describe what you want to build and agree on
the goal before workers start. Existing folders are preserved. No repository
is published to GitHub during creation.

Press **F1 → O** to open an existing repository. In F1, arrows select a project;
Enter or **C** opens its conversation and project workspace. Other sessions keep
running, and workers share one global concurrency limit.

## Everyday controls

- **F1:** all projects, create/open a project and global attention.
- **F2:** selected project's goal, tasks, workers and conversation; Tab changes panel.
- **F3:** inspect or talk directly to a worker session.
- **F4:** decisions about product and scope.
- **F5:** harness/model, worker limit and GitHub settings. Ctrl+E changes the UI
  language; Ctrl+Enter applies a different model to the current project's
  orchestrator. From F1 it saves defaults without restarting background sessions.
- **F6:** browse/import GitHub issues.
- **F7:** inspect changes, accept a delivery, preview local integration or
  prepare/edit a draft pull request. Confirm before writing to Git/GitHub.
- **Alt+1–Alt+7:** alternatives when the desktop reserves function keys.
- Click the top tabs to navigate. GitHub connection settings stay under F5;
  project issues use F6.
- **[Chat] / Ctrl+F:** open Fluke's floating chat, refocus it if unfocused, or
  close it if already focused. It stays above other sections.
  Drag its title, resize its edges, click inside to type, or press Esc/Tab to
  return focus to the background. Its open state and bounds survive reopening;
  the title and draft follow the current project.
- **Ctrl+B:** switch between mouse controls and native terminal text selection.
  Mouse controls remain available while typing in a worker terminal.
- In F3, **[p] / [*]** pins/unpins a terminal above the others for this session;
  **[+] / [-]** maximizes/restores. Keyboard `p` and `z` work in window mode.
- **Ctrl+K:** command line; **Ctrl+X:** manage terminal windows;
  **Ctrl+Y:** copy the visible conversation, session or review.

In chat, `:` is ordinary text; use Ctrl+K for commands. Ctrl+U clears the draft.
F2 opens the conversation, with clickable Chat, Plan, Workers and Balance views.
Use arrows, Home/End and Delete to edit a brief. Enter sends; Alt+Enter,
Shift+Enter or Ctrl+J insert a newline. Multiline paste keeps its paragraphs.
Send, Connection and Pin actions are visible in both docked and floating chat.
Fluke's model runs in the background; F3 shows worker terminals. Connection
opens the internal provider only for permissions or troubleshooting. Leaving
that view hides it again when you navigate back to F3.
Task rows and actions are clickable; PgUp/PgDn or the wheel scroll long task
details. Review begins with the acceptance criterion and reported evidence.
F7 follows the selected task, the task linked to a decision in F4, or the
focused worker in F3. A decision without a task opens an empty review.
To explore without creating projects or connecting a provider, run
`fluke-console.exe --demo` or double-click `open-demo.cmd`. The demo contains
three fictional projects and eight workers. F1 selects projects, F2 shows chat,
plan and balance, F3 lets you move/resize worker windows, F4 shows a decision,
and F5 previews themes. It is a read-only snapshot: messages, execution and
repository actions are disabled. It does not load or save your regular state,
create repositories, or call models; all usage figures are illustrative.

F4 is dedicated to decisions and their context, without a duplicate chat. Use
↑/↓ to choose a decision and Enter to respond; F2 opens the project chat.
Ctrl+P opens a global switcher for projects and tasks (also available in the
demo). Type words from the project, task, provider or status, then choose with
↑/↓ and Enter or click a result. Projects open Fluke's chat; a live worker opens
in window mode, while a finished/offline worker opens its task in the plan.
Switching never starts a task. Esc restores the previous editor and its draft;
Ctrl+U clears the search. Ctrl+P is reserved by Fluke, including in a terminal.
Messages whose delivery cannot be confirmed remain marked as uncertain:
open Connection before resending them. A successful pipe write alone no longer
marks a follow-up delivered: Fluke waits for paste processing and provider activity.

To start Fluke without provider approval prompts, run `open-fluke.ps1 -Autonomous`
or the executable with `--autonomous`. This saves the choice. F5 → Ctrl+A toggles
the setting; Enter saves it and Ctrl+Enter applies it to the current Fluke session.
This grants unrestricted file/command access to Fluke's Codex or Claude session.
Worker defaults stay separate. Fluke confirms only the initial trust dialog for
the exact project you opened; it does not press Enter on arbitrary permission dialogs.
Provider login, usage limits, and administrator restrictions still apply. Custom
CLIs require their own integration; they are not supported as Fluke's orchestrator.

In F2 select a task and press **m**, or use **Ctrl+X → m** on its F3 session,
to write directly to that worker. The message editor saves your instruction
for both the worker and Fluke before sending it. Enter sends; Shift+Enter adds
a line; Esc closes the editor with no send. Unsent drafts survive panel changes.
Native terminal entry remains available for CLI permissions and commands.

In F4, Enter on an answered decision prepares a correction. `:amend N answer`
keeps the original answer and appends a replacement with its source. Scope/task
proposals use a new proposal; an integrated or published delivery needs a
follow-up task. `:tell TASK_ID | message` is the command-line equivalent of **m**.
Sending never starts a stopped worker automatically. A current worker must
acknowledge a new instruction before its next delivery becomes reviewable.

In F1, Tab selects the attention panel; arrows and Enter open the alert's
project, task or native session. It includes deliveries ready for your review
and permissions in orchestrators that are not currently focused.

Published PRs are checked in the background, with one query at a time and at
most one automatic query per PR per minute. F2 and F7 show checks/review/merge
status; Ctrl+R refreshes it. Failures retain the last verified status. Remote
merge never substitutes for verified local integration or releases dependencies.

The orchestrator coordinates work within the approved goal. Changing that goal
holds previous tasks; `:adopt TASK_ID` explicitly authorizes keeping their brief
under the new goal. Edited task/goal specs also hold affected workers until
reviewed. Files, branches and native session history are preserved.

See [README.md](README.md) for the complete runtime and verification details.
