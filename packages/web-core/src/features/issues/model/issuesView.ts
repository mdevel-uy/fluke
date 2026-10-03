import type { IssueGroupBy } from '@/features/issues/ui/IssuesToolbar';

// The Lista / Grupos / Plan choice survives visits (#663). Per-browser only.
const VIEW_STORAGE_KEY = 'fluke.issues.groupBy';
const GROUP_BY_VALUES: IssueGroupBy[] = ['none', 'label', 'milestone', 'plan'];

export function readStoredGroupBy(): IssueGroupBy {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY) as IssueGroupBy | null;
    return v && GROUP_BY_VALUES.includes(v) ? v : 'plan';
  } catch {
    return 'plan';
  }
}

/** Remembers the view the Issues page opens on next time. */
export function rememberIssuesView(v: IssueGroupBy) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // Storage blocked: the view simply isn't remembered.
  }
}
