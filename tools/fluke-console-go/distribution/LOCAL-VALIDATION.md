# Local validation — 2026-10-08

The manually installed `~/.local/bin/fluke` was removed and replaced by a
private npm package built for Linux x64. The package is at
`dist/console-local-test/mdevel-fluke-0.1.0-beta.1.tgz` in the repository root.
It is installed under `~/.local/lib/node_modules/@mdevel/fluke`, with the npm
launcher linked from `~/.local/bin/fluke`. It has not been published to npm.

## Interaction correction

Applying configuration used to reject any queued chat, including messages
waiting indefinitely at a CLI permission dialog. It now waits only for an
actual write in progress. Stopping/replacing a session preserves the pending
message as uncertain and clears the previous queue; it does not blindly resend
it. Claude folder-trust requests have a specific F3 hint and attention item.

Validated locally:

- Focused Go tests for configuration changes, navigation, attention,
  conversation, provider checks and agent state passed.
- A local Claude startup test displayed the native folder-trust dialog.
- An optional real Claude Opus turn, using a temporary repository created by
  the test, answered an arithmetic prompt correctly through Fluke's PTY. The
  test confirmed trust only for its own temporary repository. Sending Down and
  Enter separately was required; the first bundled-key attempt did not confirm.
- npm launcher tests passed: platform mapping, unsupported targets, argument
  preservation, child exit codes, missing executable and incomplete packaging.
- The private package installed from its tarball without registry downloads;
  `fluke --version` reported `0.1.0-beta.1 (linux/amd64)`.
- The npm-installed interface opened and F5 displayed the saved Claude/Opus
  configuration. The separate profile is `~/.local/state/fluke-console-npm-test`;
  the original Fluke state was preserved.
- `actionlint` passed for `release-console.yml`; `git diff --check` passed.

The complete post-correction Go suite passed locally (401.687s). GitHub Actions
run [37861837684](https://github.com/mdevel-uy/fluke/actions/runs/37861837684)
passed native Go tests, launcher tests, both architecture builds, and actual npm
package installation on Linux, macOS and Windows. An additional filesystem-alias
regression test passed; worktree ownership checks accept equivalent filesystem
objects, including macOS temporary-directory aliases. The configuration test
uses its own executable and no longer requires Claude to be installed.

The validated CI artifacts were downloaded, verified against their SHA256
checksums, and installed again on this Linux machine. They are published at
[console-v0.1.0-beta.1](https://github.com/mdevel-uy/fluke/releases/tag/console-v0.1.0-beta.1).
Source changes are in [PR #856](https://github.com/mdevel-uy/fluke/pull/856),
against the original console branch. The tag workflow triggered by the manual
release was cancelled to avoid repeating publication of the same version.

The npm registry publication remains pending account authorization. The GitHub
npm tarball can be installed without an npm account. ARM64 binaries were
cross-built where the native runner uses x64. This validation establishes a
short local Claude response and the queued-chat regression, not an entire
sustained orchestrator/worker workflow on every target platform.

## Conversational chat — beta.2

The orchestrator answers conversational questions without routinely reading task
context, and its tone no longer requires every exchange to become a project goal.
Registering a question or scope proposal preserves its ack without starting an
extra model turn to restate that it is waiting. Human chat takes priority over
automatic coordination notifications.

For an exact, verified Codex or Claude native session with a recognized final
answer format, subsequent chat replies go straight to F2 from the local native
transcript. Historical messages, tools, commentary and reasoning are excluded.
The file report remains the fallback when a native channel cannot be verified,
and remains available for coordination updates. Only active reply waits use the
200ms conversation timer; worker reconciliation keeps its existing cadence.

Regression tests cover identity, final-answer filtering, partial writes, history
replay, storage failures, chat priority, proposal acknowledgments and idle timers.
A real Codex follow-up returned a normal final answer without tool calls: native
turn duration was 3.421s, versus 10.914s for the earlier equivalent question using
a report-file write. CLI startup is excluded from these native turn measurements;
a single pair of turns does not establish typical latency or a guarantee.
