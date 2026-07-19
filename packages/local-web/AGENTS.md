## Design System Styling Guidelines

### Design Direction

**Style:** Clean Modern Professional (Minimal SaaS, 2026 rounded/airy)
**Font:** Plus Jakarta Sans (sans-serif, 300–800) — friendly, modern, approachable
**Monospace:** IBM Plex Mono (code blocks, terminal output, IDs, version labels)
**Brand:** Blue (`hsl(var(--brand))` = `#2563EB` light / `#3B82F6` dark)
**Elevation:** Soft, diffused shadows — never hard black borders

### CSS Variables & Tailwind Config

All design tokens live in `../web-core/src/app/styles/new/index.css` (CSS custom properties) and `tailwind.new.config.js` (Tailwind mapping).

### Colors

**Text (semantic):**
- `text-high` — Titles, primary text
- `text-normal` — Body copy, form labels
- `text-low` — Metadata, placeholders, captions

**Backgrounds:**
- `bg-primary` — Main content bg (white / dark navy)
- `bg-secondary` — Elevated surface (inputs, cards, sidebars)
- `bg-panel` — Deeper panel

**Brand & semantic:**
- `bg-brand` / `text-brand` — Primary CTA + focus rings + active states
- `brand-hover`, `brand-secondary`
- `success`, `warning`, `error`, `info`, `destructive`, `merged`

### Typography scale

- `text-xs` 8 px · `text-sm` 10 px · `text-base` 12 px (body) · `text-lg` 14 px · `text-xl` 16 px
- Titles: use `text-lg`/`text-xl` with `font-semibold` `text-high` and `tracking-tight`
- Section labels: `text-xs font-semibold uppercase tracking-wide text-high` (or `text-low` when secondary)

### Spacing

- Custom tokens: `p-half` 6 px, `p-base` 12 px, `p-double` 24 px
- Prefer standard scale (`p-3`, `p-4`, `p-5`, `p-6`) for view/section padding to keep rhythm consistent
- Card internal padding: `p-3.5` (list cards) / `p-5` (feature cards)
- Between sections: `gap-4` to `gap-6`

### Border radius (modern rounded)

- `rounded-sm` 6 px — chips, small controls
- `rounded-md` 8 px — buttons, inputs, dropdown items
- `rounded-lg` 10 px — buttons default, inputs, tooltips
- `rounded-xl` 14 px — cards, popovers, dropdowns, alerts
- `rounded-2xl` 16 px — feature cards, dialogs, columns
- `rounded-full` — badges, pills, avatars, status dots

### Shadows (soft, diffused elevation)

- `shadow-soft` — subtle 1 px hint, cheapest elevation
- `shadow-card` — resting card elevation
- `shadow-card-hover` — hover state (paired with `hover:-translate-y-0.5`)
- `shadow-elevated` — sticky navs, secondary overlays
- `shadow-overlay` — dialogs, popovers, dropdowns, tooltips
- `shadow-focus` — programmatic focus glow

### Borders

- Default: `border-border/60` — 1 px, low-opacity slate. Never harsh black.
- Dashed empty state: `border-dashed border-border/60`

### Iconography

- **Primary set: [lucide-react](https://lucide.dev)** — all flagship views, cards, buttons, sidebar/nav
- Legacy `@phosphor-icons/react` is retained for internal editors (Lexical plugins) and specialty chat components — do not add new phosphor icons in flagship UI
- Stroke: `strokeWidth={1.75}` (default) or `2` (bold); use `2.5` for tiny 12 px icons
- Sizes: `h-3.5 w-3.5` (small buttons), `h-4 w-4` (default), `h-5 w-5` (large), `h-7 w-7` (empty-state medallions)

### Focus states

Always visible: `focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-background`.
Ring color default is `--ring` (blue). For explicit brand use `ring-brand`.

### Button variants (`Button` component)

- `primary` / `default` — solid brand fill, `shadow-soft` (main CTA)
- `tonal` — subtle brand tint (`bg-brand/10 text-brand`), for secondary CTAs
- `secondary` — bordered neutral surface
- `outline` — thin border only
- `ghost` — hover-only background
- `destructive` — solid destructive fill
- `icon` — bare icon button with hover bg
- `link` — inline text link, no chrome

Sizes: `xs` (28 px), `sm` (32 px), `default` (36 px), `lg` (44 px), `icon` (32×32).
All buttons: `active:scale-[0.98]`, 150 ms transitions, ring on focus, `disabled:opacity-50`.

### Cards & task cards

Standard card pattern:
```tsx
<article className="group flex flex-col gap-2.5 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card hover:border-border">
```

Feature cards (Worker) add: `rounded-2xl`, `shadow-card`, `hover:-translate-y-0.5`, header/metadata/actions-footer structure.

### Status pills (badges)

Pill = `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium`.
Semantic tones use `bg-{color}/10 text-{color}` — subtle tint, no harsh solid fills.
Active/live states include a small pulsing dot indicator.

### Empty states

Centered layout with:
1. Medallion icon (`h-16 w-16 rounded-2xl bg-brand/10 text-brand` container with `h-7 w-7` lucide icon)
2. Title (`text-lg font-semibold text-high`)
3. Description (`text-sm text-low leading-relaxed`)
4. Optional CTA

### Architecture rules

- **View components** — stateless, receive data via props
- **Container components** — manage state, pass to views
- **UI primitives** (`packages/ui/components/`) — reusable, PascalCase files
- Feature UI (`packages/web-core/src/features/*/ui/`) — composes UI primitives

### Accessibility

- Contrast ≥ 4.5 : 1 for body, ≥ 3 : 1 for large/UI
- All interactive elements have visible `focus-visible` rings
- Keyboard navigation preserved on every refactored component
- Icon-only buttons carry `aria-label` and (usually) `title`
- Respect `prefers-reduced-motion` — no auto-playing accents
