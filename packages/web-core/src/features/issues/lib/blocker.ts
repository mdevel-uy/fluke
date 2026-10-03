import type { IssueBlocker } from 'shared/types';

/** Phase kind a blocker points at (`dev-2` → `dev`). */
export function blockerPhaseKind(b: IssueBlocker): string | null {
  return b.phase?.replace(/-\d+$/, '') ?? null;
}

/** Age of a blocker as "14 min", "2 h", "3 d"; null without a usable date. */
export function blockerAge(since: string | null, now = Date.now()) {
  if (!since) return null;
  let iso = since.trim().replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const min = Math.max(1, Math.round((now - at) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
