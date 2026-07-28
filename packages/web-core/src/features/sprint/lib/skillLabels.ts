import type { IssueLabel } from 'shared/types';

const SKILL_LABEL_PREFIX = 'skill:';

/**
 * Extract skill names from `skill:<name>` labels on an issue.
 *
 * Labels with the `skill:` prefix are a convention: they let issue authors
 * pin a skill to a ticket on GitHub, and the app auto-selects those skills
 * when the issue is assigned to a worker. Duplicates and empty suffixes are
 * dropped so the caller receives a clean, deduplicated list.
 */
export function extractSkillLabelNames(
  labels: readonly Pick<IssueLabel, 'name'>[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    if (!label.name.startsWith(SKILL_LABEL_PREFIX)) continue;
    const name = label.name.slice(SKILL_LABEL_PREFIX.length).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
