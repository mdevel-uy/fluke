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
