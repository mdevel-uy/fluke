import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Local scratchpad on top of the authoritative server-side assumptions
 * (`Config.default_hours_saved_per_task`, `Config.default_hours_per_fte_month`,
 * `Config.default_hourly_rate`, `Config.default_currency`).
 *
 * Each field is `null` when the viewer is using the config value and a
 * number/string when they've overridden it inline to simulate a scenario.
 * The store never invents a default itself — the CTO-facing figure has
 * to come from Config so it does not diverge per browser.
 */

export const MIN_HOURS_PER_TICKET = 0.5;
export const MAX_HOURS_PER_TICKET = 80;

export const MIN_HOURS_PER_FTE_MONTH = 40;
export const MAX_HOURS_PER_FTE_MONTH = 400;

export const MIN_HOURLY_RATE = 0;
export const MAX_HOURLY_RATE = 1000;

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'ARS', 'UYU'] as const;
export type ReportCurrency = (typeof CURRENCY_OPTIONS)[number];

/**
 * Fallbacks used only while the server config is still loading. Once loaded,
 * `Config.default_*` takes over — these numbers must not sneak into a report
 * that will be shown to a CTO.
 */
export const FALLBACK_HOURS_PER_TICKET = 4;
export const FALLBACK_HOURS_PER_FTE_MONTH = 160;
export const FALLBACK_HOURLY_RATE = 75;
export const FALLBACK_CURRENCY: ReportCurrency = 'USD';

type State = {
  /** `null` means "use the config default"; a number means "simulate this". */
  hoursPerTicketOverride: number | null;
  hoursPerFteMonthOverride: number | null;
  hourlyRateOverride: number | null;
  currencyOverride: ReportCurrency | null;
  setHoursPerTicketOverride: (value: number | null) => void;
  setHoursPerFteMonthOverride: (value: number | null) => void;
  setHourlyRateOverride: (value: number | null) => void;
  setCurrencyOverride: (value: ReportCurrency | null) => void;
  resetAll: () => void;
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

const clampOverride = (
  value: number | null,
  min: number,
  max: number
): number | null => {
  if (value === null) return null;
  return clamp(value, min, max);
};

const validCurrency = (value: unknown): ReportCurrency | null => {
  return CURRENCY_OPTIONS.includes(value as ReportCurrency)
    ? (value as ReportCurrency)
    : null;
};

export const usePilotReportSettingsStore = create<State>()(
  persist(
    (set) => ({
      hoursPerTicketOverride: null,
      hoursPerFteMonthOverride: null,
      hourlyRateOverride: null,
      currencyOverride: null,
      setHoursPerTicketOverride: (value) =>
        set({
          hoursPerTicketOverride: clampOverride(
            value,
            MIN_HOURS_PER_TICKET,
            MAX_HOURS_PER_TICKET
          ),
        }),
      setHoursPerFteMonthOverride: (value) =>
        set({
          hoursPerFteMonthOverride: clampOverride(
            value,
            MIN_HOURS_PER_FTE_MONTH,
            MAX_HOURS_PER_FTE_MONTH
          ),
        }),
      setHourlyRateOverride: (value) =>
        set({
          hourlyRateOverride: clampOverride(
            value,
            MIN_HOURLY_RATE,
            MAX_HOURLY_RATE
          ),
        }),
      setCurrencyOverride: (value) => set({ currencyOverride: value }),
      resetAll: () =>
        set({
          hoursPerTicketOverride: null,
          hoursPerFteMonthOverride: null,
          hourlyRateOverride: null,
          currencyOverride: null,
        }),
    }),
    {
      name: 'kanban-pilot-report-settings',
      partialize: (state) => ({
        hoursPerTicketOverride: state.hoursPerTicketOverride,
        hoursPerFteMonthOverride: state.hoursPerFteMonthOverride,
        hourlyRateOverride: state.hourlyRateOverride,
        currencyOverride: state.currencyOverride,
      }),
      merge: (persisted, current) => {
        // A stale localStorage from before this refactor stored raw values
        // (not overrides). We drop those silently — the report page will
        // re-hydrate from server Config, which is now the source of truth.
        const saved = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          hoursPerTicketOverride: clampOverride(
            typeof saved.hoursPerTicketOverride === 'number'
              ? saved.hoursPerTicketOverride
              : null,
            MIN_HOURS_PER_TICKET,
            MAX_HOURS_PER_TICKET
          ),
          hoursPerFteMonthOverride: clampOverride(
            typeof saved.hoursPerFteMonthOverride === 'number'
              ? saved.hoursPerFteMonthOverride
              : null,
            MIN_HOURS_PER_FTE_MONTH,
            MAX_HOURS_PER_FTE_MONTH
          ),
          hourlyRateOverride: clampOverride(
            typeof saved.hourlyRateOverride === 'number'
              ? saved.hourlyRateOverride
              : null,
            MIN_HOURLY_RATE,
            MAX_HOURLY_RATE
          ),
          currencyOverride: validCurrency(saved.currencyOverride ?? null),
        };
      },
      version: 2,
    }
  )
);
