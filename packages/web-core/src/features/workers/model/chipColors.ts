/**
 * Chip tints for worker role and model badges. Roles draw from
 * blue/green/amber and models from purple/teal/pink so the two chip
 * groups never share a hue on the same card.
 */

export const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-success/10 text-success',
  reviewer: 'bg-warning/10 text-warning',
};

export const ROLE_CHIP_FALLBACK = 'bg-secondary text-normal';

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
