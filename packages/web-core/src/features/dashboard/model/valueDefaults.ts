/**
 * Fallback pricing assumptions used only while the server config is still
 * loading. Once the request completes, the values from
 * `Config.default_hourly_rate` / `Config.default_currency` take over —
 * these constants must not sneak into a figure that reaches a customer.
 */
export const DEFAULT_HOURLY_RATE = 75;
export const DEFAULT_CURRENCY = 'USD';

/**
 * Fraction of the net savings billed to the customer ("pagás el 10% de lo
 * que ahorrás"). Fallback for `Config.default_savings_fee_rate`.
 */
export const DEFAULT_SAVINGS_FEE_RATE = 0.1;

/** Clamp a fee rate to the sane 0..=1 range; NaN falls back to the default. */
export function normalizeSavingsFeeRate(
  raw: number | undefined | null,
  fallback: number = DEFAULT_SAVINGS_FEE_RATE
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(1, Math.max(0, raw));
}

/** Accept whatever the server sends; only substitute the fallback for empty. */
export function normalizeCurrency(
  raw: string | undefined | null,
  fallback: string = DEFAULT_CURRENCY
): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  return fallback;
}

/** Man-hours a resolved ticket is credited with until the config loads. */
export const DEFAULT_HOURS_PER_TASK = 4;

/** Guard rails so a typo cannot produce a nonsensical figure. */
export const MIN_HOURS_PER_TASK = 0.5;
export const MAX_HOURS_PER_TASK = 80;

/** Working hours in a month (8 h x 20 days), to translate hours into FTE. */
export const MIN_HOURS_PER_FTE_MONTH = 40;
export const MAX_HOURS_PER_FTE_MONTH = 320;
