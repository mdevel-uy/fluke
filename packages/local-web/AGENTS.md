## Design System Styling Guidelines

### Design Direction

**Style:** Clean Modern Professional (Minimal SaaS)
**Font:** Plus Jakarta Sans (sans-serif, all weights 300–800) — friendly, modern, approachable
**Monospace:** IBM Plex Mono (code blocks, terminal output, version labels)
**Brand:** Blue (`hsl(var(--brand))` = `#2563EB` light / `#3B82F6` dark)

### CSS Variables & Tailwind Config

The design system uses custom CSS variables defined in `../web-core/src/app/styles/new/index.css` and configured in `tailwind.new.config.js`.

### Colors

**Text colors** (use these instead of `text-gray-*`):
- `text-high` - Primary text, highest contrast
- `text-normal` - Standard text
- `text-low` - Muted/secondary text, placeholders

**Background colors**:
- `bg-primary` - Main background (white / dark navy)
- `bg-secondary` - Slightly tinted, used for inputs, cards, sidebars
- `bg-panel` - Panel/elevated surfaces

**Accent colors**:
- `brand` - Blue accent (`hsl(var(--brand))`)
- `brand-hover` - Lighter blue on hover
- `brand-secondary` - Darker blue for secondary actions
- `error` - Error states
- `success` - Success states

### Typography

**Font families**:
- `font-ibm-plex-sans` - Default sans-serif (resolves to Plus Jakarta Sans)
- `font-ibm-plex-mono` - Monospace/code

**Font sizes** (smaller than typical Tailwind defaults — intentional for dense UI):
- `text-xs` - 8px
- `text-sm` - 10px
- `text-base` - 12px (default)
- `text-lg` - 14px
- `text-xl` - 16px

### Spacing

Custom spacing tokens:
- `p-half` / `m-half` - 6px
- `p-base` / `m-base` - 12px
- `p-double` / `m-double` - 24px

### Border Radius

Larger radii for a modern feel:
- `rounded-sm` - 4px
- `rounded` / `rounded-md` - 6px (default)
- `rounded-lg` - 8px

### Focus States

Focus rings use `ring-brand` (blue) and are inset by default.

### Example Component Styling

```tsx
// Input field
className="px-base bg-secondary rounded border text-base text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"

// Button (icon)
className="flex items-center justify-center bg-secondary rounded border text-low hover:text-normal"

// Primary CTA
className="bg-brand hover:bg-brand-hover text-on-brand rounded px-base py-half"

// Sidebar container
className="w-64 bg-secondary shrink-0 p-base"
```

### Architecture Rules

- **View components** (in `views/`) should be stateless - receive all data via props
- **Container components** (in `containers/`) manage state and pass to views
- **UI components** (in `ui-new/`) are reusable primitives
- File names in `ui-new/` must be **PascalCase** (e.g., `Field.tsx`, `Label.tsx`)

### Accessibility

- Minimum contrast 4.5:1 for body text, 3:1 for large text and UI components
- All interactive elements must have visible focus indicators (`focus-visible:ring-2 focus-visible:ring-brand`)
- Keyboard navigation must not be broken
- Use `aria-label` on icon-only buttons
