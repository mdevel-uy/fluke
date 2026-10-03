import type { Ticket } from 'shared/types';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';

/** Shared thresholds: context usage and plan meters use the same scale. */
export const METER_WARN_RATIO = 0.7;
export const METER_CRIT_RATIO = 0.9;

export function contextRatio(ws: SidebarWorkspace | undefined): number | null {
  if (!ws?.contextUsage || ws.contextUsage.contextWindow <= 0) return null;
  return Math.min(
    1,
    ws.contextUsage.totalTokens / ws.contextUsage.contextWindow
  );
}

/**
 * Parse an API timestamp into a Date. SQLite strings ("YYYY-MM-DD HH:MM:SS")
 * are UTC without a zone; RFC3339 strings already carry one.
 */
export function parseSqliteUtc(value: string): Date {
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value)) return new Date(value);
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/** Compact elapsed since a timestamp: 45s, 6m, 3h, 2d */
export function formatDurationSince(dateString: string): string {
  const diffSecs = Math.max(
    0,
    Math.floor((Date.now() - parseSqliteUtc(dateString).getTime()) / 1000)
  );
  if (diffSecs < 60) return `${diffSecs}s`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

/** Local calendar day of a timestamp -- not `toISOString`, which is UTC. */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function localMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Hours a ticket is credited with: its override, else the default. */
export function ticketHours(ticket: Ticket, defaultHours: number): number {
  return ticket.hours_override ?? defaultHours;
}

export type TicketDay = {
  /** Local calendar day, "YYYY-MM-DD". */
  dayKey: string;
  /** Local midnight of that day, for axis formatting. */
  date: Date;
  count: number;
  cost: number;
  /** In API order (newest first). */
  tickets: Ticket[];
};

/**
 * Group resolved tickets into one bucket per local calendar day, oldest
 * first, covering exactly `days` days up to and including today. Quiet days
 * stay as zero buckets so the x-axis is a real calendar.
 */
export function bucketTicketsByDay(
  tickets: Ticket[],
  days: number
): TicketDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets: TicketDay[] = [];
  const byDay = new Map<string, TicketDay>();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const bucket: TicketDay = {
      dayKey: localDayKey(date),
      date,
      count: 0,
      cost: 0,
      tickets: [],
    };
    buckets.push(bucket);
    byDay.set(bucket.dayKey, bucket);
  }

  for (const ticket of tickets) {
    if (!ticket.resolved_at) continue;
    const bucket = byDay.get(localDayKey(parseSqliteUtc(ticket.resolved_at)));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.cost += ticket.cost_usd;
    bucket.tickets.push(ticket);
  }

  return buckets;
}

export type TicketMonth = {
  /** Local month, "YYYY-MM". */
  key: string;
  date: Date;
  count: number;
  hours: number;
  cost: number;
};

/** The last `months` local calendar months, newest first, current included. */
export function ticketsByMonth(
  tickets: Ticket[],
  months: number,
  defaultHours: number
): TicketMonth[] {
  const now = new Date();
  const rows: TicketMonth[] = [];
  for (let i = 0; i < months; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    rows.push({ key: localMonthKey(date), date, count: 0, hours: 0, cost: 0 });
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const ticket of tickets) {
    if (!ticket.resolved_at) continue;
    const row = byKey.get(localMonthKey(parseSqliteUtc(ticket.resolved_at)));
    if (!row) continue;
    row.count += 1;
    row.hours += ticketHours(ticket, defaultHours);
    row.cost += ticket.cost_usd;
  }
  return rows;
}

/**
 * Format an hours figure for display, without a unit -- the caller appends a
 * translated one. Keeps at most one decimal.
 */
export function formatManHours(hours: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(hours);
}

export const usdFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const AGENT_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'Claude',
  CODEX: 'Codex',
  COPILOT: 'GitHub Copilot',
  GEMINI: 'Gemini',
  AMP: 'Amp',
  CURSOR_AGENT: 'Cursor',
  OPENCODE: 'Opencode',
  QWEN_CODE: 'Qwen',
  DROID: 'Droid',
};

/** "CLAUDE_CODE" → "Claude". */
export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

/** "17:00" for a reset later today, "Tue 09:00" or "1 nov" otherwise. */
export function formatResetAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000)
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return date.toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
