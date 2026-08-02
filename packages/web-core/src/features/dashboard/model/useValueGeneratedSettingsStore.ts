import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  VALUE_HISTORY_WINDOWS,
  type ValueHistoryWindow,
} from './useValueGenerated';

/**
 * Default man-hours a completed worker task is credited with when nothing on
 * the task carries an override. Anchored on the pricing conversation: four
 * hours is the round number that lines up with the "half a working day" story
 * we tell customers, and matches the issue-353 default.
 */
export const DEFAULT_HOURS_PER_TASK = 4;

/** Guard rails so a typo cannot produce a nonsensical FTE figure. */
export const MIN_HOURS_PER_TASK = 0.5;
export const MAX_HOURS_PER_TASK = 80;

/**
 * Working hours in a month used to translate hours saved into FTE. 160 =
 * 8 h × 20 working days, the common industry benchmark. Kept editable
 * because a viewer's local working-hours assumption may differ.
 */
export const DEFAULT_HOURS_PER_FTE_MONTH = 160;
export const MIN_HOURS_PER_FTE_MONTH = 40;
export const MAX_HOURS_PER_FTE_MONTH = 320;

type State = {
  /**
   * Hours attributed to a completed task without a per-task override.
   * Kept client-side (same pattern as `useImpactSettingsStore`): it is a
   * display assumption a viewer should be able to challenge inline.
   */
  hoursPerTask: number;
  /** Working hours in a month used to render the FTE equivalent. */
  hoursPerFteMonth: number;
  /** Trailing history depth rendered by the panel. */
  historyMonths: ValueHistoryWindow;
  setHoursPerTask: (hours: number) => void;
  setHoursPerFteMonth: (hours: number) => void;
  setHistoryMonths: (months: ValueHistoryWindow) => void;
};

const clampHoursPerTask = (hours: number): number => {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_TASK;
  return Math.min(MAX_HOURS_PER_TASK, Math.max(MIN_HOURS_PER_TASK, hours));
};

const clampHoursPerFteMonth = (hours: number): number => {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_FTE_MONTH;
  return Math.min(
    MAX_HOURS_PER_FTE_MONTH,
    Math.max(MIN_HOURS_PER_FTE_MONTH, hours)
  );
};

export const useValueGeneratedSettingsStore = create<State>()(
  persist(
    (set) => ({
      hoursPerTask: DEFAULT_HOURS_PER_TASK,
      hoursPerFteMonth: DEFAULT_HOURS_PER_FTE_MONTH,
      historyMonths: 12,
      setHoursPerTask: (hours) =>
        set({ hoursPerTask: clampHoursPerTask(hours) }),
      setHoursPerFteMonth: (hours) =>
        set({ hoursPerFteMonth: clampHoursPerFteMonth(hours) }),
      setHistoryMonths: (months) => set({ historyMonths: months }),
    }),
    {
      name: 'kanban-value-generated-settings',
      partialize: (state) => ({
        hoursPerTask: state.hoursPerTask,
        hoursPerFteMonth: state.hoursPerFteMonth,
        historyMonths: state.historyMonths,
      }),
      merge: (persisted, current) => {
        // A hand-edited or stale localStorage entry must not brick the panel.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          hoursPerTask: clampHoursPerTask(
            saved.hoursPerTask ?? DEFAULT_HOURS_PER_TASK
          ),
          hoursPerFteMonth: clampHoursPerFteMonth(
            saved.hoursPerFteMonth ?? DEFAULT_HOURS_PER_FTE_MONTH
          ),
          historyMonths: VALUE_HISTORY_WINDOWS.includes(
            saved.historyMonths as ValueHistoryWindow
          )
            ? (saved.historyMonths as ValueHistoryWindow)
            : 12,
        };
      },
    }
  )
);
