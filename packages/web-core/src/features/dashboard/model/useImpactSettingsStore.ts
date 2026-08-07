import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { IMPACT_WINDOWS, type ImpactWindow } from './useClosedIssues';

/**
 * Fallback baseline used only when the server config is still loading. Once
 * it lands, the panel prefers `Config.default_hours_saved_per_task` — same
 * anchor as the value-generated / pilot-report surfaces so the three tell
 * one story.
 */
export const DEFAULT_HOURS_PER_ISSUE = 4;

/** Guard rails for the editable factor, so a typo cannot produce nonsense. */
export const MIN_HOURS_PER_ISSUE = 0.5;
export const MAX_HOURS_PER_ISSUE = 80;

type State = {
  /**
   * Per-viewer override of the man-hours attributed to closing one issue.
   * `null` means "use the installation default" (server config, or the
   * fallback constant while it loads). A number lets the viewer challenge
   * the estimate inline without polluting what other viewers see.
   */
  hoursPerIssueOverride: number | null;
  windowDays: ImpactWindow;
  setHoursPerIssueOverride: (hours: number | null) => void;
  setWindowDays: (days: ImpactWindow) => void;
};

const clampHoursOverride = (hours: number | null): number | null => {
  if (hours === null) return null;
  if (!Number.isFinite(hours)) return null;
  return Math.min(MAX_HOURS_PER_ISSUE, Math.max(MIN_HOURS_PER_ISSUE, hours));
};

export const useImpactSettingsStore = create<State>()(
  persist(
    (set) => ({
      hoursPerIssueOverride: null,
      windowDays: 30,
      setHoursPerIssueOverride: (hours) =>
        set({ hoursPerIssueOverride: clampHoursOverride(hours) }),
      setWindowDays: (days) => set({ windowDays: days }),
    }),
    {
      name: 'kanban-impact-settings',
      partialize: (state) => ({
        hoursPerIssueOverride: state.hoursPerIssueOverride,
        windowDays: state.windowDays,
      }),
      merge: (persisted, current) => {
        // A hand-edited / pre-refactor localStorage entry (which stored a
        // raw `hoursPerIssue` number, not an override) must not break the
        // panel. We drop that legacy field and re-hydrate from server config.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          hoursPerIssueOverride: clampHoursOverride(
            typeof saved.hoursPerIssueOverride === 'number'
              ? saved.hoursPerIssueOverride
              : null
          ),
          windowDays: IMPACT_WINDOWS.includes(saved.windowDays as ImpactWindow)
            ? (saved.windowDays as ImpactWindow)
            : 30,
        };
      },
      version: 2,
    }
  )
);
