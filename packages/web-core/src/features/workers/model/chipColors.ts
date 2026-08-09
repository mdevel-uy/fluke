/**
 * Chip tints for worker role and model badges. Roles draw from
 * blue/green/amber and models from purple/teal/pink so the two chip
 * groups never share a hue on the same card.
 *
 * The role palette (`ROLE_CHIP_CLASS`, `ROLE_CHIP_FALLBACK`) is defined in
 * `@vibe/ui/lib/roleChipClass` so `WorkspaceSummary` (which lives in the UI
 * kit) can share the exact same source. We re-export from here to avoid
 * touching the existing web-core consumers.
 */

import { ROLE_CHIP_FALLBACK } from '@vibe/ui/lib/roleChipClass';

export {
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '@vibe/ui/lib/roleChipClass';

const MODEL_CHIP_CLASS: [match: string, className: string][] = [
  ['opus', 'bg-merged/10 text-merged'],
  ['sonnet', 'bg-teal/10 text-teal'],
  ['haiku', 'bg-pink/10 text-pink'],
];

export function modelChipClass(model: string): string {
  const normalized = model.toLowerCase();
  return (
    MODEL_CHIP_CLASS.find(([match]) => normalized.includes(match))?.[1] ??
    ROLE_CHIP_FALLBACK
  );
}
