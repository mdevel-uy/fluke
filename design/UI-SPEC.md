---
scope: Redesign (standalone)
slug: workbench-redesign
status: approved
approved_by: Dani ("me encanta, adelante" — 21-jul-2026, sobre el artifact); paleta indigo/zinc aprobada 25-jul-2026
created: 2026-07-21
version: 3 (Workbench · paleta Slate & Signal) — supersedes v2 (VSCode blue/grays)
reference: https://claude.ai/code/artifact/635ca11f-dfae-4c33-962c-b9bd19d6f5ae
supersedes: design/DESIGN-DIRECTION.md ("ProjectFlow") and UI-SPEC v1/v2 (same file, git history)
---

# Workbench — Design Contract (v3)

> Vibe Kanban keeps the **Workbench structure** (dense rows, system typography
> at 13px, 16px monochrome icons, borders over ornament) with the **palette of
> the approved dashboard mockup**: zinc grays, one indigo accent, soft
> elevation. The v2 VSCode palette is gone — see the table below.
> On any conflict with `packages/local-web/AGENTS.md` or older docs, this wins.

## Palette

Zinc scale + a single indigo accent, from the approved mockup
(`factory-dashboard-mockup.html`). Tokens live in
`packages/web-core/src/app/styles/new/index.css` (HSL triplets; `--md-*` names
kept as migration aliases) and are mapped in
`packages/local-web/tailwind.new.config.js`.

| Role | Light | Dark | Tailwind |
|---|---|---|---|
| app ground (behind cards) | `#F4F4F5` zinc-100 | `#09090B` zinc-950 | `bg-md-background` |
| card / panel | `#FFFFFF` | `#18181B` zinc-900 | `bg-card` / `bg-md-surface-container-lowest` |
| elevated input / rail | `#FAFAFA` | `#101012` | `bg-md-surface-container-low` |
| hover | `#F4F4F5` | `#27272A` zinc-800 | `bg-secondary` / `bg-md-surface-container` |
| active/pressed | `#E4E4E7` zinc-200 | `#3F3F46` zinc-700 | `bg-md-surface-container-high` |
| list selection | `#EEF2FF` indigo-50 | `#312E81` indigo-900 | `bg-sel` |
| border (default) | `#E4E4E7` | `#3F3F46` | `border-border` |
| border (strong: inputs, menus) | `#D4D4D8` | `#52525B` | `border-border-strong` |
| text primary | `#18181B` | `#FAFAFA` | `text-high` |
| text secondary | `#3F3F46` | `#D4D4D8` | `text-normal` |
| text tertiary | `#71717A` | `#A1A1AA` | `text-low` |
| **accent fill** | `#4F46E5` indigo-600 | `#6366F1` indigo-500 | `bg-brand` + `text-on-brand` |
| **accent text/icon** | `#4F46E5` | `#818CF8` indigo-400 | `text-brand-on-surface` |
| success / merged-ok | `#16A34A` | `#4ADE80` | `text-success` |
| warning / queued | `#D97706` | `#FBBF24` | `text-warning` |
| error / destructive | `#DC2626` | `#F87171` | `text-error` / `bg-destructive` |
| modified / in-review | `#D97706` | `#FBBF24` | `text-mod` |
| info | `#0284C7` | `#38BDF8` | `text-info` |
| merged | `#7C3AED` | `#A78BFA` | `text-merged` |

Semantic colors map to the **triplet** vars (`--_success`, `--_warning`,
`--_info`), never to the public `--success`/`--warning`/`--info`, which resolve
to full colors and would nest `hsl()` inside `hsl()` (that bug made every
`bg-success` transparent until 25-jul-2026).

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
| Mono | `font-mono text-code` | 12px | 400 — branches, hashes, IDs, timestamps |

Legacy `text-{display-lg,headline-md,title-sm,body-md,body-sm,label-caps}`
aliases resolve onto this scale — do not use in new code.

## Density, shape, elevation

- Heights: list/tree rows **22px** · buttons/inputs/menu items **26px**
  (`h-[26px]`) · table rows **30px** · tabs/panel titles **~36px** (`h-9`) ·
  status bar **22px** · activity rail **~56px wide** (40px items + 8px padding).
- Radii: `rounded-sm` **4px** (chips, swatches) · `rounded-md` **6px**
  (buttons, inputs) · `rounded-lg` **12px** (cards, rows, KPI tiles) ·
  `rounded-xl` **14px** (panels, menus, dialogs, toasts) · `rounded-full`
  (pills, dots). `2xl/3xl` are clamped to 14px.
- Elevation: **soft and low-contrast.** `shadow-soft` for cards/KPI tiles,
  `shadow-card` for raised or hovered surfaces (both from `--shadow-*` tokens,
  per theme); `shadow-overlay` for menus/dialogs/toasts. Depth stays subtle —
  no `hover:-translate-y-*` lift anywhere; hover = background/border change.
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
2. **Shadows only from the `shadow-*` tokens** (`soft`, `card`, `overlay`);
   never a hand-written `box-shadow` on a component.
3. **No hover-lift / scale transforms.**
4. **No radius > 14px** except pills (`rounded-full`); use the scale, not
   arbitrary `rounded-[Npx]`.
5. **One indigo.** Indigo that isn't action/active/focus/link/selection is a
   bug. Role and model chips are the documented exception (they encode
   identity, not action).
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
