# Fluke Console

A terminal workspace for projects and coding agents. Native Go executables
for Windows, Linux and macOS, on x64 and ARM64, are included in this package.
Node.js 22 or newer is required for the npm launcher; Go is not required.

```sh
npm install -g --allow-remote=all https://github.com/mdevel-uy/fluke/releases/download/console-v0.1.0-beta.1/mdevel-fluke-0.1.0-beta.1.tgz
fluke --lang es
fluke --version
fluke --repo /path/to/your/project
```

Git is required to work with repositories. To use agents, install and sign in
to Codex CLI or Claude Code separately. GitHub CLI is optional.
The first launch guides you through setup; no model session starts until you
send a message. Each provider uses your own account and usage allowance.

The GitHub beta is public; npm registry publication is still pending account
authorization. Once published to the registry, install or update with
`npm install -g @mdevel/fluke@beta`. Uninstall with
`npm uninstall -g @mdevel/fluke`. Your project files and saved Fluke state are
preserved. The default state directory is `~/.local/state/fluke-console` on
Linux/macOS and `%LOCALAPPDATA%/fluke-console` on Windows.

This is a beta. Builds and automated tests do not substitute for validating
interactive terminals and long-running agent sessions on each target system.

Downloads and source: https://github.com/mdevel-uy/fluke
