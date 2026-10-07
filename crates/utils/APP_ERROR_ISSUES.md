# GitHub app-error lookup (#658)

Set `FLUKE_GITHUB_ISSUES_TOKEN` in the environment of the Cargo build. The
utils crate embeds it with `option_env!`; setting it only at runtime or loading
it in the server build script from `.env` does not configure this feature.
Unset/empty means disabled, without logging an error. Never use a `VITE_`
variable. The credential stays in Rust and is never included in snapshots.

An embedded credential can be extracted from a distributed binary. Use a
dedicated, revocable token with read-only issues access to `mdevel-uy/fluke`,
not a personal/admin token. This change does not provision release secrets;
the build environment owner must supply it. No Sentry/license secret injection
was found in the repository's desktop release workflow.

C2 must include this plain-text line in each issue body:

```
Fluke fingerprint: fp-xxxxxxxxxxxx
```

The fingerprint comes from `app_errors::fingerprint`; clients must not generate
it. Lookup searches the body for the quoted fingerprint and checks exact token
boundaries in the returned body. Open issues and issues closed within
`RECENT_DAYS` (90) count. Pull requests, unsafe URLs, and older closures do not.
Incomplete/truncated results fail closed. The query syntax was exercised against
the real GitHub search API, including a body query returning #658 and #659.

Finite snapshots start one asynchronous lookup per unseen fingerprint, without
blocking tracing/panic capture. The total lookup timeout is three seconds; the
one-second snapshot polling adds up to two seconds to initial delivery. Results,
including failures, remain cached for the session. A stopped task degrades from
checking to failed on the next snapshot. No resources are created, so there is
nothing to roll back. Any request failure backs off new searches for 60 seconds;
at most ten lookups (twenty requests) start per minute. Errors arriving during
backoff/budget exhaustion are cached as failed, never treated as missing.
The cache keeps at most 4096 fingerprints; overflow fails closed without retries.

Only `missing` is eligible for C2's future create flow. `checking`, `failed`,
`disabled`, and `existing` must never enable creation. Existing issues get a
subtle notice with a link and the normal repetition counter; Ignore still works.

Verification for infrastructure: run the services app_error_issues unit tests and `pnpm run check`,
build with and without the variable, exercise an open matching issue, a recent
closed match and an old closed match, and simulate 401/403/429/offline responses.
Unit cases cover query scope, exact matches, the date window, incomplete and
truncated results, concurrent lookup reservation, cached results across snapshots,
timeout, task cancellation, backoff and exhausted search budget. All async
cache tests use isolated session state and simulated futures, without GitHub.
No checks were run in the worker session.

PR: Closes #658. GitHub HTTP lookup lives in services, reusing its existing
reqwest dependency. utils holds capture, the wire result and the build token.
No dependencies or lockfile changes are needed. No TS derives were added and
shared generated types were not edited.

Territory crossings: `crates/server/src/routes/app_errors.rs` enriches the
existing capture pipeline's snapshot with the service result. The seven
`packages/web-core/src/i18n/locales/*/common.json` files supply the new notice
strings; i18n keys are explicitly included in the issue's written territory.
Bootstrap and the UI error reporter remain untouched.
