import type { TFunction } from 'i18next';

/**
 * Label of a phase kind of the issue plan. The phases of profiles the user
 * put in the flow (`pre:<slug>`, `gate:<slug>`) are named after their
 * profile, or their slug when the profile is unknown; besides, the `:` would
 * read as an i18n namespace.
 */
export function phaseKindLabel(
  t: TFunction<'common'>,
  kind: string,
  profile?: string | null
): string {
  const at = kind.indexOf(':');
  if (at >= 0) return profile || kind.slice(at + 1);
  return t(`issues.plan.phases.kind.${kind}`);
}
