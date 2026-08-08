import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  VALUE_HISTORY_WINDOWS,
  type ValueHistoryWindow,
} from './useValueGenerated';

/**
 * Default man-hours a completed worker task is credited with when the
 * installation has not been configured. Anchored on the pricing
 * conversation: four hours is the round number that lines up with the
 * "half a working day" story we tell customers, and matches the issue-353
 * default. Only used as a fallback while the server config is loading —
 * once loaded, `Config.default_hours_saved_per_task` takes over.
 */
export const DEFAULT_HOURS_PER_TASK = 4;

/** Guard rails so a typo cannot produce a nonsensical FTE figure. */
export const MIN_HOURS_PER_TASK = 0.5;
export const MAX_HOURS_PER_TASK = 80;

/**
 * Working hours in a month used to translate hours saved into FTE. 160 =
 * 8 h × 20 working days, the common industry benchmark. Only used as a
 * fallback while the server config is loading — once loaded,
 * `Config.default_hours_per_fte_month` takes over.
 */
export const DEFAULT_HOURS_PER_FTE_MONTH = 160;
export const MIN_HOURS_PER_FTE_MONTH = 40;
export const MAX_HOURS_PER_FTE_MONTH = 320;

export const clampHoursPerTask = (hours: number): number => {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_TASK;
  return Math.min(MAX_HOURS_PER_TASK, Math.max(MIN_HOURS_PER_TASK, hours));
};

export const clampHoursPerFteMonth = (hours: number): number => {
  if (!Number.isFinite(hours)) return DEFAULT_HOURS_PER_FTE_MONTH;
  return Math.min(
    MAX_HOURS_PER_FTE_MONTH,
    Math.max(MIN_HOURS_PER_FTE_MONTH, hours)
  );
};

/**
 * View-only state for the value-generated panel: the trailing history
 * window each viewer prefers. Kept in localStorage because it's a UI
 * preference (not authoritative business data), so per-browser is the
 * right scope.
 *
 * All pricing assumptions (`hoursPerTask`, `hoursPerFteMonth`,
 * `hourlyRate`, `currency`) live on the server in Config — the number
 * that anchors pricing must not diverge per browser. See #459.
 */
type State = {
  /** Trailing history depth rendered by the panel. */
  historyMonths: ValueHistoryWindow;
  setHistoryMonths: (months: ValueHistoryWindow) => void;
};

export const useValueGeneratedSettingsStore = create<State>()(
  persist(
    (set) => ({
      historyMonths: 12,
      setHistoryMonths: (months) => set({ historyMonths: months }),
    }),
    {
      name: 'kanban-value-generated-settings',
      partialize: (state) => ({
        historyMonths: state.historyMonths,
      }),
      merge: (persisted, current) => {
        // A hand-edited or stale localStorage entry must not brick the panel.
        // Older versions of this store persisted `hourlyRate` / `currency`;
        // those keys are ignored here — the values now come from Config.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          historyMonths: VALUE_HISTORY_WINDOWS.includes(
            saved.historyMonths as ValueHistoryWindow
          )
            ? (saved.historyMonths as ValueHistoryWindow)
            : 12,
        };
      },
      version: 2,
    }
  )
);
