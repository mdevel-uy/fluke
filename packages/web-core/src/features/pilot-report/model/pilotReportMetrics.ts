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
  monetaryValue: number;
  windowDays: number;
}

export interface PilotReportAssumptions {
  hoursPerTicket: number;
  hoursPerFteMonth: number;
  hourlyRate: number;
}

export function computePilotReportMetrics(
  data: PilotReportData,
  assumptions: PilotReportAssumptions,
  windowStart: Date,
  windowEnd: Date
): PilotReportMetrics {
  const ticketsResolved = data.completed_tasks.filter(
    (t) => t.status === 'done'
  ).length;
  const ticketsFailed = data.completed_tasks.filter(
    (t) => t.status === 'failed'
  ).length;
  const prsMerged = data.merged_prs.length;

  const hoursSaved = ticketsResolved * assumptions.hoursPerTicket;

  // Guard against a zero-hours FTE assumption to avoid NaN in the KPI.
  const fteEquivalent =
    assumptions.hoursPerFteMonth > 0
      ? hoursSaved / assumptions.hoursPerFteMonth
      : 0;

  const monetaryValue = hoursSaved * assumptions.hourlyRate;

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
