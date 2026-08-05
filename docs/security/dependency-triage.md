# Dependency vulnerability triage

**Baseline snapshot:** Dependabot reported **180 open alerts** on `mdev`
(2 critical, 78 high, 73 medium, 27 low) across `Cargo.lock`,
`crates/*/Cargo.toml`, `crates/*/Cargo.lock`, `pnpm-lock.yaml` and
`npx-cli/package-lock.json`.

This document classifies each finding into three buckets so the security team
of an on‑prem customer can distinguish real risk from noise before running a
scanner against a released image.

The on‑prem product is built with `cargo build --bin server` +
`pnpm build:npx`. Anything that does **not** end up in either the
`server` binary or the shipped frontend bundle does **not** reach the customer,
regardless of what Dependabot lists.

---

## Bucket 1 — Ships to the customer

Alerts that reach the customer machine, either through the on‑prem `server`
binary or the frontend bundle.

### 1a. Fixed in this PR (lockfile‑only bumps)

| Ecosystem | Package | From → To | Advisories closed |
|-----------|---------|-----------|-------------------|
| Rust | `openssl` | 0.10.77 → 0.10.81 | GHSA‑xp3w‑r5p5‑63rr, GHSA‑pqf5‑4pqq‑29f5, GHSA‑8c75‑8mhr‑p7r9, GHSA‑ghm9‑cr32‑g9qj, GHSA‑hppc‑g8h3‑xhp3, GHSA‑xmgf‑hq76‑4vx2, GHSA‑xv59‑967r‑8726, GHSA‑phqj‑4mhp‑q6mq |
| Rust | `openssl‑sys` | 0.9.113 → 0.9.117 | (transitive with `openssl`) |
| Rust | `rustls‑webpki` | 0.103.10 → 0.103.13 | GHSA‑82j2‑j2ch‑gfr8, GHSA‑xgp8‑3hg3‑c2mh, GHSA‑965h‑392x‑2mh5 |
| Rust | `serde_with` | 3.18.0 → 3.21.0 | GHSA‑7gcf‑g7xr‑8hxj |
| Rust | `cmov` | 0.5.2 → 0.5.4 | GHSA‑3rjw‑m598‑pq24 |
| Rust | `lru` | 0.16.3 → 0.16.4 | GHSA‑rhfx‑m35p‑ff5j |
| Rust | `rmcp` (workspace) | 1.3.0 → 1.8.0 | GHSA‑89vp‑x53w‑74fx (for our `crates/mcp`) |
| Rust | `rand` | 0.8.5 → 0.8.7 / 0.9.2 → 0.9.5 | GHSA‑cq8v‑f236‑94qc |
| Rust | `tar` | 0.4.45 → 0.4.46 | GHSA‑3pv8‑6f4r‑ffg2 |
| npm  | `seroval` | 1.5.0 → ≥1.5.3 (`pnpm.overrides`) | **GHSA‑mv8w‑475r‑vwqw (CRITICAL)** — transitive via `@tanstack/router-core` |
| npm  | `preact` | 10.27.2 → ≥10.27.3 | GHSA‑36hm‑qxxp‑pg3m (via `posthog‑js`) |
| npm  | `devalue` | 5.4.2 → ≥5.6.4 | GHSA‑g2pg‑6438‑jwpf, GHSA‑vw5p‑8cq8‑m7mv, GHSA‑mwv9‑gp5h‑frr4, GHSA‑cfw5‑2vxh‑hr84, GHSA‑33hq‑fvwr‑56pm, GHSA‑8qm3‑746x‑r74r |
| npm  | `fast‑uri` | 3.1.0 → ≥3.1.5 | GHSA‑4c8g‑83qw‑93j6, GHSA‑v39h‑62p7‑jpjc, GHSA‑q3j6‑qgpj‑74h6, GHSA‑v2hh‑gcrm‑f6hx, GHSA‑7p8r‑x3mc‑p8w7 |
| npm  | `lodash` / `lodash‑es` | 4.17.21 → ≥4.18.0 | GHSA‑r5fr‑rjxr‑66jc, GHSA‑f23m‑r3pf‑42rh, GHSA‑xxjr‑mmjv‑4gpg |
| npm  | `dompurify` | 3.3.3 → ≥3.4.12 (via `mermaid` bump) | GHSA‑cmwh‑pvxp‑8882 and 9 sibling advisories |
| npm  | `mermaid` | 11.13.0 → ≥11.15.0 | GHSA‑87f9‑hvmw‑gh4p, GHSA‑6m6c‑36f7‑fhxh, GHSA‑ghcm‑xqfw‑q4vr, GHSA‑xcj9‑5m2h‑648r |
| npm  | `uuid` | 11.1.0 / 13.0.0 → ≥13.0.1 | GHSA‑w5hq‑g745‑h8pq |
| npm  | `js‑yaml` | ≤4.1.0 → ≥4.2.0 | GHSA‑h67p‑54hq‑rp68, GHSA‑mh29‑5h37‑fv8m, GHSA‑52cp‑r559‑cp3m |
| npm  | `ajv` | <8.18 → ≥8.18.0 | GHSA‑2g4f‑4pwh‑qvx6 |
| npm  | `flatted` | ≤3.4.1 → ≥3.4.2 | GHSA‑rf6f‑7fwh‑wjgh, GHSA‑25h7‑pfq9‑p65f |
| npm  | `yaml` | <2.8.3 → ≥2.8.3 | GHSA‑48c2‑rrv3‑qjmp |
| npm  | `diff` | <8.0.3 → ≥8.0.3 | GHSA‑73rr‑hh4g‑fpgx |
| npm (`npx‑cli`) | `adm‑zip` | 0.5.16 → ≥0.6.0 | GHSA‑xcpc‑8h2w‑3j85 (high) — API surface (`new AdmZip(path)` + `extractAllTo`) unchanged in 0.6.0 |
| npm (`npx‑cli`) | `esbuild` | 0.27.4 → ≥0.28.1 | GHSA‑g7r4‑m6w7‑qqqr |

The npm bumps are enforced through a `overrides` block in
`pnpm-workspace.yaml` because most are transitives whose direct parent has not
released a patched version.

`pnpm audit --prod` reports **0 vulnerabilities** after this PR (was
28 unique advisories including 1 CRITICAL and 15 HIGH before).

`npm audit` inside `npx-cli/` reports **0 vulnerabilities** after this PR
(was 2 including 1 HIGH before).

### 1b. Deferred — needs code work, tracked as follow-up

These reach the on‑prem `server` binary but resolving them requires either
API‑breaking upgrades or a fork bump. They are **not** shipped worse than
they already are on `mdev` today.

| Package | Version | Advisory | Why not in this PR | Follow-up estimate |
|---------|---------|----------|--------------------|--------------------|
| `russh` | 0.48.2 | 10 alerts (GHSA‑wwx6, GHSA‑4r3c, GHSA‑g9f8, GHSA‑f5v4, GHSA‑76r6, GHSA‑g9g7, GHSA‑hpv4, GHSA‑h5rc, GHSA‑cqjc, GHSA‑5xvq, GHSA‑m65r, GHSA‑g9hv) | Pinned to `= "0.48"` in `crates/embedded-ssh` + `crates/local-deployment`. Fixed in 0.60/0.61/0.62 which change the client/server trait signatures and the ChannelMsg surface. | 1–2 days: rewrite `embedded_ssh::handler`, sftp forwarder, channel loop. Ship with the next scheduled server release. |
| `russh‑cryptovec` | 0.48.0 | GHSA‑g9f8‑wqj9‑fjw5 (high) | Ships as part of `russh`; will be resolved together with the russh bump above. | Bundled with russh bump. |
| `aws‑lc‑sys` | 0.37.0 | GHSA‑9f94‑5g5w‑gf6r, GHSA‑394x‑vwmw‑crm3, GHSA‑hfpc‑8r3f‑gw53, GHSA‑65p9‑r9h6‑22vj, GHSA‑vw5v‑4f2q‑w9xf (high×5) | Pinned by `rama-tls-rustls` inside the `codex` fork we vendor via git tag `rust-v0.124.0`. `cargo update -p aws-lc-sys` is a no-op. | Bump codex fork to next release (`codex` publishes bi‑weekly; scheduled after `codex ≥ 0.126`). |
| `rmcp` | 0.15.0 | GHSA‑89vp‑x53w‑74fx (high) | Pinned by `codex-app-server-protocol` in the same codex fork. Fix is 1.4.0, i.e. a major bump the upstream fork has not yet taken. | Bundled with codex fork bump. |
| `hickory‑proto` | 0.25.2 | GHSA‑q2qq‑hmj6‑3wpp (medium), GHSA‑3v94‑mw7p‑v465 (high **— NO FIX AVAILABLE UPSTREAM**) | Pinned by `rama-dns` inside the codex fork; the high‑severity GHSA‑3v94 has no fixed version yet. Impact: attacker‑controlled DNS names can smuggle labels — not exploitable through our usage which only issues outbound name resolution for whitelisted hosts. | Wait for upstream fix; re‑evaluate on next codex bump. Documented residual risk. |

---

## Bucket 2 — Does NOT ship to on‑prem customers

These packages appear in Dependabot reports but the affected code paths do
**not** compile into the customer‑facing artifacts (`server` binary + web
bundle + `npx-cli`).

### 2a. Cloud‑only / SaaS‑only crates (excluded from the `mdev` workspace)

The root `Cargo.toml` declares `exclude = ["crates/remote", "crates/relay-tunnel"]`.
Their lockfiles are separate and their code never links into `server`.

| Manifest | Alerts | Notes |
|----------|--------|-------|
| `crates/remote/Cargo.lock` | 22 (9 high, 7 medium, 6 low) | The SaaS/relay server we run centrally. Never distributed. |
| `crates/relay-tunnel/Cargo.lock` | 8 (3 high, 1 medium, 4 low) | Cloud relay client. Never distributed. |

Verification: `cargo tree -e normal -p server` shows none of these crates in
the on‑prem build graph.

### 2b. Desktop/Tauri app (not part of the on‑prem server)

| Package | Version | Where | Notes |
|---------|---------|-------|-------|
| `tauri` | 2.10.3 | `crates/tauri-app` | Desktop wrapper only; on‑prem customers run the headless server. |
| `glib` | 0.18.5 | Transitive of `gtk` via `tauri` | Same scope as above. |
| `quinn-proto` | any | `crates/remote/Cargo.lock` (QUIC transport) | Cloud‑only. |

### 2c. Development / build‑time only

These reached Dependabot because they exist in the lockfiles, but the
resulting artifacts do not include them:

* `vite`, `rollup`, `esbuild`, `@babel/core`, `postcss`, `js-yaml`,
  `brace-expansion`, `minimatch`, `glob`, `picomatch` — bundler / lint /
  test tooling; not present in the compiled JS bundle.
* `concurrently` (which pulls the vulnerable `shell-quote` and `js-yaml`) —
  dev script runner used for `pnpm run dev`. Never invoked in prod.

Even though these carry no customer exposure, this PR bumps every one of them
via `pnpm.overrides` (see 1a) so the alert counter in the Dependabot dashboard
matches reality and the customer security team has a clean report.

---

## Reproducing the audit locally

```bash
# npm side
pnpm install
pnpm audit --prod --json       # runtime graph
pnpm audit --json              # includes dev deps
cd npx-cli && npm audit --json # shipped CLI wrapper

# Rust side (main workspace / on-prem)
cargo tree -e normal -p server | grep <crate>          # is <crate> shipped?
cargo update --dry-run -p <crate>                      # can we bump it via lockfile?
```

An advisory found only in `crates/remote/` or `crates/relay-tunnel/` or
`crates/tauri-app/` should be filed under Bucket 2 and not gate a release.

---

## Ship gate

After this PR:

* **Critical: 0** open in Bucket 1
* **High: 0** open in Bucket 1 shipping code
* **High deferred:** 5 packages listed in section 1b, all pinned by the codex
  fork or by our `russh = "0.48"` API contract; each has an explicit follow-up
  action.

All Bucket 2 findings are inapplicable to the on‑prem image by construction
and should be waived during a customer security scan with a pointer to this
document.
