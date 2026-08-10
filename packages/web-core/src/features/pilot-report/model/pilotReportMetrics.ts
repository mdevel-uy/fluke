import type { PilotReportData } from './usePilotReport';

/**
 * Derived metrics the CTO-facing summary shows. All computed from the
 * raw counts and the viewer's tunable assumptions so the numbers stay
 * traceable — hover any KPI to see the formula in the settings row.
 */
export interface PilotReportMetrics {
  ticketsResolved: number;
  ticketsFailed: number;
  prsMerged: number;
  hoursSaved: number;
  fteEquivalent: number;
  /** Gross monetary value: hours × hourly rate. */
  monetaryValue: number;
  /** LLM/API cost rolled up from every completed task in the window,
   *  in USD. Reported here (not converted to `currency`) because the LLM
   *  APIs bill in USD — the pilot report presents it in the viewer's
   *  chosen currency assuming 1:1 as a simplification. */
  apiCostUsd: number;
  /** Net monetary value: gross − API cost, floored at 0. */
  netMonetaryValue: number;
  /** Slice of the net savings that gets invoiced: `netMonetaryValue ×
   *  feeRate` — the "you pay a percentage of what you save" pricing model.
   *  Same math as the value-generated panel so both surfaces tell the
   *  same story. */
  serviceFee: number;
  /** Token totals across resolved tasks (null usage rows contribute 0).
   *  Shown next to the API cost so the spend stays traceable to what was
   *  actually consumed. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Effective hourly rate on net savings: `netMonetaryValue / hoursSaved`.
   *  Zero when hours are zero. */
  effectiveHourlyRate: number;
  /** Tickets that have any recorded cost (i.e. an executor reported usage).
   *  Used to flag partial coverage in the UI. */
  ticketsWithCost: number;
  /** True when at least one resolved ticket has no cost data — the cost /
   *  net figures are then lower / upper bounds, not exact. */
  partialCostCoverage: boolean;
  windowDays: number;
}

export interface PilotReportAssumptions {
  hoursPerTicket: number;
  hoursPerFteMonth: number;
  hourlyRate: number;
  /** Fraction (0..=1) of the net savings that gets invoiced. */
  feeRate: number;
}

export function computePilotReportMetrics(
  data: PilotReportData,
  assumptions: PilotReportAssumptions,
  windowStart: Date,
  windowEnd: Date
): PilotReportMetrics {
  const resolvedTasks = data.completed_tasks.filter((t) => t.status === 'done');
  const ticketsResolved = resolvedTasks.length;
  const ticketsFailed = data.completed_tasks.filter(
    (t) => t.status === 'failed'
  ).length;
  const prsMerged = data.merged_prs.length;

  // Same formula the value-generated panel uses: per-task overrides
  // contribute their stored hours verbatim, tasks without one get the
  // installation default. Keeping the math aligned means both surfaces
  // tell the same story for the same window.
  const overrideSum = resolvedTasks.reduce(
    (sum, t) => sum + (t.hours_saved_override ?? 0),
    0
  );
  const tasksWithOverride = resolvedTasks.filter(
    (t) => t.hours_saved_override !== null
  ).length;
  const tasksWithoutOverride = Math.max(0, ticketsResolved - tasksWithOverride);
  const hoursSaved =
    overrideSum + tasksWithoutOverride * assumptions.hoursPerTicket;

  // Guard against a zero-hours FTE assumption to avoid NaN in the KPI.
  const fteEquivalent =
    assumptions.hoursPerFteMonth > 0
      ? hoursSaved / assumptions.hoursPerFteMonth
      : 0;

  const monetaryValue = hoursSaved * assumptions.hourlyRate;

  // Sum only tasks with a non-null cost — treating null as zero would
  // silently understate what the client actually paid for API tokens.
  let apiCostUsd = 0;
  let ticketsWithCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  for (const task of resolvedTasks) {
    if (task.cost_usd !== null && task.cost_usd !== undefined) {
      apiCostUsd += task.cost_usd;
      ticketsWithCost += 1;
    }
    inputTokens += task.input_tokens ?? 0;
    outputTokens += task.output_tokens ?? 0;
    cacheCreationTokens += task.cache_creation_tokens ?? 0;
    cacheReadTokens += task.cache_read_tokens ?? 0;
  }
  const partialCostCoverage =
    ticketsResolved > 0 && ticketsWithCost < ticketsResolved;

  const netMonetaryValue = Math.max(0, monetaryValue - apiCostUsd);
  const serviceFee = netMonetaryValue * assumptions.feeRate;
  const effectiveHourlyRate =
    hoursSaved > 0 ? netMonetaryValue / hoursSaved : 0;

  const msPerDay = 24 * 60 * 60 * 1000;
  const windowDays = Math.max(
    1,
    Math.round((windowEnd.getTime() - windowStart.getTime()) / msPerDay)
  );

  return {
    ticketsResolved,
    ticketsFailed,
    prsMerged,
    hoursSaved,
    fteEquivalent,
    monetaryValue,
    apiCostUsd,
    netMonetaryValue,
    serviceFee,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    effectiveHourlyRate,
    ticketsWithCost,
    partialCostCoverage,
    windowDays,
  };
}

/** Formatter for FTE months with one decimal, avoiding trailing "0.0". */
export function formatFte(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}

/** Formatter for hours with at most one decimal. */
export function formatHours(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (value >= 100) return Math.round(value).toString();
  return value % 1 === 0 ? value.toString() : value.toFixed(1);
}
