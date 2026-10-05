/**
 * What the merge button of an approved PR can do (#798), from the state
 * fluke last polled. Only conflicts and red CI block it (the server refuses
 * the same cases with a 409); the uncertain cases let the user merge with a
 * notice. Contract: design/merge-button-placement-mock.html, section 5.
 */

export type MergeBlock = 'conflicts' | 'ciFailing' | 'both';

export type MergeNotice =
  | 'ciPending'
  | 'ciNone'
  | 'ciUnavailable'
  | 'mergeableUnknown';

export type CiFact = 'ok' | 'failing' | 'pending' | 'none' | 'unavailable';

export interface MergeGateState {
  /** Why the button is disabled, or null when it can merge. */
  block: MergeBlock | null;
  /** Highest-priority notice for an enabled button. */
  notice: MergeNotice | null;
  ci: CiFact;
  conflicts: boolean;
}

export function ciFact(ciStatus: string | null | undefined): CiFact {
  switch (ciStatus) {
    case 'passing':
      return 'ok';
    case 'failing':
      return 'failing';
    case 'pending':
      return 'pending';
    case 'none':
      return 'none';
    default:
      // `unknown`, not polled yet, or a value this UI does not know.
      return 'unavailable';
  }
}

export function mergeGateState(
  mergeable: string | null | undefined,
  ciStatus: string | null | undefined
): MergeGateState {
  const ci = ciFact(ciStatus);
  const conflicts = mergeable === 'conflicting';
  const failing = ci === 'failing';
  const block: MergeBlock | null =
    conflicts && failing
      ? 'both'
      : conflicts
        ? 'conflicts'
        : failing
          ? 'ciFailing'
          : null;
  let notice: MergeNotice | null = null;
  if (!block) {
    if (ci === 'pending') notice = 'ciPending';
    else if (ci === 'unavailable') notice = 'ciUnavailable';
    else if (mergeable !== 'mergeable') notice = 'mergeableUnknown';
    else if (ci === 'none') notice = 'ciNone';
  }
  return { block, notice, ci, conflicts };
}
