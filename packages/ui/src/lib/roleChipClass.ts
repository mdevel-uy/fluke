/**
 * Tailwind classes for worker role chips.
 *
 * Lives in `@vibe/ui` so both the shared UI kit (e.g. `WorkspaceSummary`)
 * and `@vibe/web-core` consumers can share a single source of truth for the
 * role palette.
 */

export const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-success/10 text-success',
  reviewer: 'bg-warning/10 text-warning',
  designer: 'bg-pink/10 text-pink',
};

export const ROLE_CHIP_FALLBACK = 'bg-secondary text-normal';
