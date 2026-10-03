import type { IssueLabel } from 'shared/types';

/**
 * Tags a milestone shows next to its name in the Plan view
 * (design/mockups/fluke-v2/milestone-actions.dc.html): the labels of its
 * issues, minus the ones fluke uses for control (`wave:*`, `feature:*`,
 * `pm:*`, `resource:*`, `epic`). The highest priority goes first, the rest
 * by how many issues carry them.
 */

export interface MilestoneTag {
  name: string;
  /** GitHub hex color, without `#`. */
  color: string;
  priority: boolean;
}

const INTERNAL = /^(wave[:-]|feature:|pm:|resource:)|^epic$/i;

const PRIORITY_RANK: Record<string, number> = {
  p0: 0,
  'priority: urgent': 0,
  p1: 1,
  'priority: high': 1,
  p2: 2,
  'priority: medium': 2,
  p3: 3,
  'priority: low': 3,
};

export function milestoneTags(
  issues: readonly { labels: readonly IssueLabel[] }[]
): MilestoneTag[] {
  let priority: { label: IssueLabel; rank: number } | null = null;
  const counts = new Map<string, { label: IssueLabel; n: number }>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      const rank = PRIORITY_RANK[label.name.toLowerCase()];
      if (rank !== undefined) {
        if (!priority || rank < priority.rank) priority = { label, rank };
        continue;
      }
      if (INTERNAL.test(label.name)) continue;
      const c = counts.get(label.name);
      if (c) c.n++;
      else counts.set(label.name, { label, n: 1 });
    }
  }
  const rest = [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.name.localeCompare(b.label.name))
    .map(({ label }) => ({ ...label, priority: false }));
  return priority ? [{ ...priority.label, priority: true }, ...rest] : rest;
}

/** Black or white, whichever reads on the given background. */
export function textOn(hex: string): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1a1a1a' : '#ffffff';
}
