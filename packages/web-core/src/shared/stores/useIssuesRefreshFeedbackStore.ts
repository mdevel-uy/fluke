import { create } from 'zustand';

// Issue #427 · transient feedback shown in the status bar after an issues
// refresh (polling refetch or manual sync). Rendered by StatusBarContainer;
// populated by useRepoIssues when the cached list changes.

export type IssuesRefreshFeedbackKind = 'new' | 'none';

export interface IssuesRefreshFeedback {
  kind: IssuesRefreshFeedbackKind;
  count: number;
  // Monotonic id lets the container remount to restart transitions if a new
  // feedback arrives while an older one is still visible.
  id: number;
}

interface State {
  feedback: IssuesRefreshFeedback | null;
  setFeedback: (kind: IssuesRefreshFeedbackKind, count: number) => void;
  clearFeedback: () => void;
}

export const ISSUES_REFRESH_FEEDBACK_TTL_MS = 4000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let idCounter = 0;

export const useIssuesRefreshFeedbackStore = create<State>()((set) => ({
  feedback: null,
  setFeedback: (kind, count) => {
    if (clearTimer) clearTimeout(clearTimer);
    idCounter += 1;
    set({ feedback: { kind, count, id: idCounter } });
    clearTimer = setTimeout(() => {
      clearTimer = null;
      set({ feedback: null });
    }, ISSUES_REFRESH_FEEDBACK_TTL_MS);
  },
  clearFeedback: () => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({ feedback: null });
  },
}));
