import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { IMPACT_WINDOWS, type ImpactWindow } from './useClosedIssues';

/** Baseline estimate of how long one issue would take a person, in hours. */
export const DEFAULT_HOURS_PER_ISSUE = 6;

/** Guard rails for the editable factor, so a typo cannot produce nonsense. */
export const MIN_HOURS_PER_ISSUE = 0.5;
export const MAX_HOURS_PER_ISSUE = 80;

type State = {
  /**
   * Man-hours attributed to closing one issue. Deliberately a local display
   * assumption rather than backend config: it is an estimate the viewer should
   * be able to challenge and adjust inline, next to the number it produces.
   */
  hoursPerIssue: number;
  windowDays: ImpactWindow;
  setHoursPerIssue: (hours: number) => void;
  setWindowDays: (days: ImpactWindow) => void;
};

const clampHours = (hours: number): number => {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_ISSUE;
  return Math.min(MAX_HOURS_PER_ISSUE, Math.max(MIN_HOURS_PER_ISSUE, hours));
};

export const useImpactSettingsStore = create<State>()(
  persist(
    (set) => ({
      hoursPerIssue: DEFAULT_HOURS_PER_ISSUE,
      windowDays: 30,
      setHoursPerIssue: (hours) => set({ hoursPerIssue: clampHours(hours) }),
      setWindowDays: (days) => set({ windowDays: days }),
    }),
    {
      name: 'kanban-impact-settings',
      partialize: (state) => ({
        hoursPerIssue: state.hoursPerIssue,
        windowDays: state.windowDays,
      }),
      merge: (persisted, current) => {
        // A hand-edited or stale localStorage entry must not break the panel.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          hoursPerIssue: clampHours(
            saved.hoursPerIssue ?? DEFAULT_HOURS_PER_ISSUE
          ),
          windowDays: IMPACT_WINDOWS.includes(saved.windowDays as ImpactWindow)
            ? (saved.windowDays as ImpactWindow)
            : 30,
        };
      },
    }
  )
);
