---
scope: Redesign (standalone)
slug: workbench-redesign
status: approved
approved_by: Dani ("me encanta, adelante" — 21-jul-2026, sobre el artifact)
created: 2026-07-21
version: 2 (Workbench) — supersedes v1 "Slate & Signal" (same file, git history)
reference: https://claude.ai/code/artifact/635ca11f-dfae-4c33-962c-b9bd19d6f5ae
supersedes: design/DESIGN-DIRECTION.md ("ProjectFlow") and UI-SPEC v1 ("Slate & Signal")
---

# Workbench — Design Contract (v2)

> Vibe Kanban adopts the **VSCode visual language**: flat panels separated by
> 1px borders (no shadows on surfaces), 22px row density, system typography at
> 13px, 16px monochrome icons, and a single VSCode-blue accent. Approved by
> Dani from the interactive artifact (link in frontmatter) — that page is the
> visual reference; this file is the implementable contract.
> On any conflict with `packages/local-web/AGENTS.md` or older docs, this wins.

## Palette

Dark-first. Tokens live in `packages/web-core/src/app/styles/new/index.css`
(HSL triplets; `--md-*` names kept as migration aliases) and are mapped in
`packages/local-web/tailwind.new.config.js`.

| Role | Light | Dark | Tailwind |
|---|---|---|---|
| canvas (editor area) | `#FFFFFF` | `#1F1F1F` | `bg-background` / `bg-primary` |
| chrome panels (rail, bars, columns, table headers) | `#F8F8F8` | `#181818` | `bg-md-surface-container-lowest` |
| card (cards, menus, dialogs, toasts) | `#F8F8F8` | `#242424` | `bg-card` |
| hover | `#ECECEC` | `#2A2D2E` | `bg-secondary` / `bg-md-surface-container` |
| active/pressed | `#E4E6ED` | `#37373D` | `bg-md-surface-container-high` |
| list selection | `#E0ECF7` | `#04395E` | `bg-sel` |
| border (default) | `#E5E5E5` | `#2B2B2B` | `border-border` |
| border (strong: inputs, menus) | `#CECECE` | `#3C3C3C` | `border-border-strong` |
| text primary | `#3B3B3B` | `#CCCCCC` (never pure white) | `text-high` |
| text secondary | `#616161` | `#9D9D9D` | `text-normal` |
| text tertiary | `#8B8B8B` | `#6E6E6E` | `text-low` |
| **accent fill** | `#005FB8` | `#0078D4` | `bg-brand` + `text-on-brand` |
| **accent text/icon** | `#005FB8` | `#4DAAFC` | `text-brand-on-surface` |
| success / merged-ok | `#107C10` | `#89D185` | `text-success` |
| warning / queued | `#855F00` | `#CCA700` | `text-warning` |
| error / destructive | `#C42B1C` | `#F14C4C` | `text-error` / `bg-destructive` |
| modified / in-review | `#895503` | `#E2C08D` | `text-mod` |
| info | link blue | `#75BEFF` | `text-info` |

**Accent reserved for:** primary CTA fill, active nav/tab/rail item, focus
rings, links, selection (`sel`), count badges, and the running task's accent
stripe + pulsing dot. Everything else is neutral gray. Semantic colors are for
state only, never decoration.

## Typography

System font stacks — **zero webfonts** (removed `@fontsource/*`):
- Sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif` (`font-sans`)
- Mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` (`font-mono`) — branches, hashes, IDs, terminal

4 sizes, 2 weights (400/600):

| Role | Class | Size | Weight |
|---|---|---|---|
| Heading | `text-heading` | 20px | 600 — page/dialog-level only, rare |
| Title | `text-title` | 15px | 600 — panel/card/dialog titles |
| Body (base) | `text-body` / `text-sm` / `text-base` | 13px | 400 — everything by default |
| Label | `text-label` / `text-xs` | 11px | 600 caps — section headers, status bar, column headers, badges |

Legacy `text-{display-lg,headline-md,title-sm,body-md,body-sm,label-caps}`
aliases resolve onto this scale — do not use in new code.

## Density, shape, elevation

- Heights: list/tree rows **22px** · buttons/inputs/menu items **26px**
  (`h-[26px]`) · table rows **30px** · tabs/panel titles **~36px** (`h-9`) ·
  status bar **22px** · activity rail **~56px wide** (40px items + 8px padding).
- Radii: `rounded-sm/md` **2px** (controls) · `rounded-lg` **4px** (cards, rows,
  columns) · `rounded-xl` **6px** (menus, dialogs, toasts) · `rounded-full`
  (pills, dots). `2xl/3xl` are clamped to 6px.
- Elevation: **borders, not shadows.** `shadow-{soft,card,card-hover,elevated}`
  resolve to `none`; `shadow-overlay` exists only for menus/dialogs/toasts.
  No `hover:-translate-y-*` lift anywhere; hover = background/border change.
  `active:translate-y-px` on buttons (no scale transforms).
- Focus: `focus-visible:ring-1 ring-brand` (1px, VSCode-style), no ring offset.

## Workbench chrome

- **Activity rail** (`AppBar.tsx`): 40px items on panel bg; active = 2px left
  accent stripe + full-contrast icon (no tinted pill); inactive = `text-md-outline`.
- **Top bar** (`Navbar.tsx`): `h-9`, panel bg, breadcrumbs center, icon
  utilities right; active icon = `bg-brand/10 text-brand-on-surface`.
- **Status bar** (`StatusBar.tsx` + `StatusBarContainer.tsx`): NEW — 22px strip
  spanning the shell bottom (desktop grid row 3): brand block, version, sync
  state (error count in red when failing), update action, ⌘K entry.
- **Sidebar panels**: keep existing collapse mechanisms; 22px tree rows,
  uppercase 11px section headers with chevrons; selection = `bg-sel`.

## Components

- Button: variants unchanged; 26px default, 2px radius, no shadows/scale.
- Card: `bg-card border-border rounded-lg`, header/body/footer, `p-4`.
- Kanban: columns = `bg-md-surface-container-lowest border-border rounded-lg`
  wells; task cards = `bg-card`, hover = border-strong + subtle bg, selected =
  `ring-1 ring-brand-on-surface bg-sel/50`; running task keeps the 2px accent
  stripe + pulsing dot (only persistent accent on the board).
- Table: 11px caps header on panel bg, 30px rows, hairline separators,
  hover `bg-secondary` — no zebra.
- Menus/dialogs/toasts: `bg-card border-border-strong rounded-xl shadow-overlay`;
  menu item selection `bg-sel`; dialog titles `text-title`, `p-4`.
- Empty states: welcome-view style — title + body + optional primary button.
  **No decorative icon medallions.**
- Icons: lucide-react 16px stroke 1.75 (2 for emphasis), monochrome via
  `currentColor`; color only when it encodes state. `MaterialIcon` is a
  lucide shim (legacy string API) — use lucide directly in new code.
  Icon-only controls require `aria-label` + tooltip, no exceptions.

## Prohibitions (the standardization contract — grep-checkable)

1. **No hardcoded palette classes** (`text-blue-500`, `bg-sky-100`, loose hex)
   in components — semantic tokens only. Exemptions: ANSI/syntax classes,
   third-party brand logos (e.g. Google).
2. **No shadows on surfaces**; shadow = overlay-only.
3. **No hover-lift / scale transforms.**
4. **No radius > 6px** except pills (`rounded-full`).
5. **One blue.** Blue that isn't action/active/focus/link/selection is a bug.
6. **No webfonts.**

## Copywriting

Unchanged from v1: reuse existing i18n strings; destructive pattern
`{Question}? This action cannot be undone.` + `Delete`/`Cancel`; terse
"what failed + retry" errors. All user-facing strings via i18n.

## Non-goals / deferrals

- Full Phosphor-icon migration in legacy chat/editor components (incremental).
- Mobile keeps its current navigation pattern (drawer + tab strip), retinted.
- `half`/`plusfifty` spacing tokens remain as deprecated aliases pending
  incremental call-site migration.
