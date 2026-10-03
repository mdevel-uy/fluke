/**
 * The user's arrangement of the Plan view: starred milestones first, then
 * the rest, each part in the order the user dragged them to. Milestones the
 * user never moved keep their default order, after the ones they did.
 */
export function arrangeMilestones<T extends { milestone: string }>(
  bands: readonly T[],
  starred: readonly string[],
  order: readonly string[]
): { starred: T[]; rest: T[] } {
  const pos = (m: string) => {
    const i = order.indexOf(m);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...bands].sort((a, b) => pos(a.milestone) - pos(b.milestone));
  return {
    starred: sorted.filter((b) => starred.includes(b.milestone)),
    rest: sorted.filter((b) => !starred.includes(b.milestone)),
  };
}

/**
 * New saved order after moving `from` to where `to` is, within `shown` (the
 * milestones in the order they are on screen). Milestones not on screen keep
 * their saved place after them.
 */
export function moveMilestone(
  order: readonly string[],
  shown: readonly string[],
  from: string,
  to: string
): string[] {
  if (from === to || !shown.includes(from) || !shown.includes(to)) {
    return [...order];
  }
  const next = shown.filter((m) => m !== from);
  const at = shown.indexOf(to) > shown.indexOf(from) ? 1 : 0;
  next.splice(next.indexOf(to) + at, 0, from);
  return [...next, ...order.filter((m) => !shown.includes(m))];
}
