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
 * Fully-loaded hourly rate used to translate saved hours into a monetary
 * figure. Kept in the store (not in `Config` yet) so the panel can present
 * net-savings today; when #459 lands a server-side default, migrate to
 * reading it from `Config.default_hourly_rate` here.
 */
export const DEFAULT_HOURLY_RATE = 75;
export const MIN_HOURLY_RATE = 0;
export const MAX_HOURLY_RATE = 1000;

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'ARS', 'UYU'] as const;
export type ReportCurrency = (typeof CURRENCY_OPTIONS)[number];
export const DEFAULT_CURRENCY: ReportCurrency = 'USD';

export const clampHourlyRate = (rate: number): number => {
  if (!Number.isFinite(rate)) return DEFAULT_HOURLY_RATE;
  return Math.min(MAX_HOURLY_RATE, Math.max(MIN_HOURLY_RATE, rate));
};

/**
 * View-only state for the value-generated panel: the trailing history
 * window each viewer prefers. Kept in localStorage because it's a UI
 * preference (not authoritative business data), so per-browser is the
 * right scope.
 *
 * The `hoursPerTask` and `hoursPerFteMonth` defaults live on the server
 * (`Config.default_hours_saved_per_task`,
 * `Config.default_hours_per_fte_month`) so every viewer sees the same
 * authoritative figure — the number that anchors pricing must not
 * diverge per browser.
 */
type State = {
  /** Trailing history depth rendered by the panel. */
  historyMonths: ValueHistoryWindow;
  /** Fully-loaded hourly rate used to compute monetary savings. */
  hourlyRate: number;
  /** Currency the monetary figures are displayed in. */
  currency: ReportCurrency;
  setHistoryMonths: (months: ValueHistoryWindow) => void;
  setHourlyRate: (rate: number) => void;
  setCurrency: (currency: ReportCurrency) => void;
};

export const useValueGeneratedSettingsStore = create<State>()(
  persist(
    (set) => ({
      historyMonths: 12,
      hourlyRate: DEFAULT_HOURLY_RATE,
      currency: DEFAULT_CURRENCY,
      setHistoryMonths: (months) => set({ historyMonths: months }),
      setHourlyRate: (rate) => set({ hourlyRate: clampHourlyRate(rate) }),
      setCurrency: (currency) => set({ currency }),
    }),
    {
      name: 'kanban-value-generated-settings',
      partialize: (state) => ({
        historyMonths: state.historyMonths,
        hourlyRate: state.hourlyRate,
        currency: state.currency,
      }),
      merge: (persisted, current) => {
        // A hand-edited or stale localStorage entry must not brick the panel.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          historyMonths: VALUE_HISTORY_WINDOWS.includes(
            saved.historyMonths as ValueHistoryWindow
          )
            ? (saved.historyMonths as ValueHistoryWindow)
            : 12,
          hourlyRate: clampHourlyRate(saved.hourlyRate ?? DEFAULT_HOURLY_RATE),
          currency: CURRENCY_OPTIONS.includes(saved.currency as ReportCurrency)
            ? (saved.currency as ReportCurrency)
            : DEFAULT_CURRENCY,
        };
      },
    }
  )
);
