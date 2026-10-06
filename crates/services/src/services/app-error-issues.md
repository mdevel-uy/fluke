# App error issue lookup (#658)

Set `FLUKE_GITHUB_TOKEN` in the environment of the **Cargo build**, including
the `utils` crate. `option_env!` embeds it in the binary. Missing or blank values
disable lookup quietly; there is no runtime fallback. `utils/build.rs` tracks
changes because build-script environment values in server/Tauri do not propagate
to dependencies. Server and Tauri also track changes to the variable.

Use a read-only, repository-scoped token for this search-only feature. Embedded
tokens can be extracted from distributed binaries. Do not embed a token with
write permissions; C2 must resolve issue-creation credentials separately.
Release secret injection for Sentry/license credentials is not present in the
repository workflows inspected for this change; release infrastructure must
provide this variable externally. No secrets are committed here.

C2's body contract is the visible line `Fluke fingerprint: fp-<12 hex digits>`.
The service searches the exact quoted fingerprint with `repo:mdevel-uy/fluke
is:issue in:body`, first `is:open`, then `is:closed closed:>=YYYY-MM-DD`.
The latter date is 90 days ago (`RECENT_DAYS`). The returned body must contain
the exact fingerprint as a complete token; the returned closure timestamp must
also be within the window. Links are constructed from the fixed repository
and returned issue number. A read-only request against GitHub's real search API
accepted this query shape and returned a complete empty result for a sample
fingerprint. No issues were created or modified for verification.

Snapshots initiate asynchronous lookup once per fingerprint. A four-second
deadline includes queueing, both searches and response parsing. Results,
including failures, remain cached for the session. Failures also pause new
network lookups for 60 seconds; searches are serialized. A 1,000-fingerprint
session limit bounds memory and network volume; later errors degrade to a failed
verification notice. Neither capture nor the snapshot response waits for GitHub.
Timeout, invalid credentials, rate limits, incomplete results and network errors
show the original error with creation unavailable. Partial work creates no remote
resources and needs no rollback. Restarting the app resets the cache.

Verification: unit tests cover query scope, exact body matching, open/recent/old
closed issues, PR exclusion and incomplete/truncated responses. They are left for
CI/post-script execution, as are builds with and without `FLUKE_GITHUB_TOKEN`.
No dependencies, lockfile changes or generated TypeScript types are added.

Closes #658
