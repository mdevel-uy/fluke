/**
 * Fallback pricing assumptions used only while the server config is still
 * loading. Once the request completes, the values from
 * `Config.default_hourly_rate` / `Config.default_currency` take over —
 * these constants must not sneak into a figure that reaches a customer.
 */
export const DEFAULT_HOURLY_RATE = 75;
export const DEFAULT_CURRENCY = 'USD';

/** Accept whatever the server sends; only substitute the fallback for empty. */
export function normalizeCurrency(
  raw: string | undefined | null,
  fallback: string = DEFAULT_CURRENCY
): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  return fallback;
}
