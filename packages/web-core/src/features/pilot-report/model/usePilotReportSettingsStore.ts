import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Assumptions that turn raw counts into a story management can read.
 *
 * These live in a store rather than in project config so the viewer can
 * adjust them inline next to the numbers they produce — the same logic
 * the impact panel uses for its hours-per-issue factor.
 */

/** Hours a person would spend on one resolved ticket, on average. */
export const DEFAULT_HOURS_PER_TICKET = 6;
export const MIN_HOURS_PER_TICKET = 0.5;
export const MAX_HOURS_PER_TICKET = 80;

/** Hours in one FTE-month (person-month). Default: 4 weeks × 40h. */
export const DEFAULT_HOURS_PER_FTE_MONTH = 160;
export const MIN_HOURS_PER_FTE_MONTH = 40;
export const MAX_HOURS_PER_FTE_MONTH = 400;

/** Fully-loaded hourly rate in the chosen currency. */
export const DEFAULT_HOURLY_RATE = 75;
export const MIN_HOURLY_RATE = 0;
export const MAX_HOURLY_RATE = 1000;

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'ARS', 'UYU'] as const;
export type ReportCurrency = (typeof CURRENCY_OPTIONS)[number];
export const DEFAULT_CURRENCY: ReportCurrency = 'USD';

type State = {
  hoursPerTicket: number;
  hoursPerFteMonth: number;
  hourlyRate: number;
  currency: ReportCurrency;
  setHoursPerTicket: (hours: number) => void;
  setHoursPerFteMonth: (hours: number) => void;
  setHourlyRate: (rate: number) => void;
  setCurrency: (currency: ReportCurrency) => void;
};

const clamp = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

export const usePilotReportSettingsStore = create<State>()(
  persist(
    (set) => ({
      hoursPerTicket: DEFAULT_HOURS_PER_TICKET,
      hoursPerFteMonth: DEFAULT_HOURS_PER_FTE_MONTH,
      hourlyRate: DEFAULT_HOURLY_RATE,
      currency: DEFAULT_CURRENCY,
      setHoursPerTicket: (hours) =>
        set({
          hoursPerTicket: clamp(
            hours,
            MIN_HOURS_PER_TICKET,
            MAX_HOURS_PER_TICKET,
            DEFAULT_HOURS_PER_TICKET
          ),
        }),
      setHoursPerFteMonth: (hours) =>
        set({
          hoursPerFteMonth: clamp(
            hours,
            MIN_HOURS_PER_FTE_MONTH,
            MAX_HOURS_PER_FTE_MONTH,
            DEFAULT_HOURS_PER_FTE_MONTH
          ),
        }),
      setHourlyRate: (rate) =>
        set({
          hourlyRate: clamp(
            rate,
            MIN_HOURLY_RATE,
            MAX_HOURLY_RATE,
            DEFAULT_HOURLY_RATE
          ),
        }),
      setCurrency: (currency) => set({ currency }),
    }),
    {
      name: 'kanban-pilot-report-settings',
      partialize: (state) => ({
        hoursPerTicket: state.hoursPerTicket,
        hoursPerFteMonth: state.hoursPerFteMonth,
        hourlyRate: state.hourlyRate,
        currency: state.currency,
      }),
      merge: (persisted, current) => {
        // Stale or hand-edited storage must not crash the report page.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          hoursPerTicket: clamp(
            saved.hoursPerTicket ?? DEFAULT_HOURS_PER_TICKET,
            MIN_HOURS_PER_TICKET,
            MAX_HOURS_PER_TICKET,
            DEFAULT_HOURS_PER_TICKET
          ),
          hoursPerFteMonth: clamp(
            saved.hoursPerFteMonth ?? DEFAULT_HOURS_PER_FTE_MONTH,
            MIN_HOURS_PER_FTE_MONTH,
            MAX_HOURS_PER_FTE_MONTH,
            DEFAULT_HOURS_PER_FTE_MONTH
          ),
          hourlyRate: clamp(
            saved.hourlyRate ?? DEFAULT_HOURLY_RATE,
            MIN_HOURLY_RATE,
            MAX_HOURLY_RATE,
            DEFAULT_HOURLY_RATE
          ),
          currency: CURRENCY_OPTIONS.includes(saved.currency as ReportCurrency)
            ? (saved.currency as ReportCurrency)
            : DEFAULT_CURRENCY,
        };
      },
    }
  )
);
