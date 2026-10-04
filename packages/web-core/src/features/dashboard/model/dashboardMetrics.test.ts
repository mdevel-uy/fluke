import { describe, it, expect } from 'vitest';
import type { Ticket } from 'shared/types';
import {
  awaitingMergeTickets,
  bucketTicketsByDay,
  formatManHours,
  parseSqliteUtc,
  ticketsByMonth,
} from './dashboardMetrics';

/**
 * Render an instant the way the API does: UTC, "YYYY-MM-DD HH:MM:SS.SSS".
 *
 * Tests build their inputs from local `Date`s and convert here, so assertions
 * about local-day bucketing hold in any timezone the suite runs in.
 */
function sqliteUtcFor(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}

function ticketAt(
  instant: Date,
  issueNumber: number | null,
  cost = 1,
  hoursOverride: number | null = null
): Ticket {
  return {
    key: `r1:issue:${issueNumber}`,
    repo_id: 'r1',
    issue_number: issueNumber,
    is_pr: false,
    title: 'ticket',
    resolved_at: sqliteUtcFor(instant),
    cost_usd: cost,
    tasks: 1,
    hours_override: hoursOverride,
    edit_task_id: null,
    edit_worker_id: null,
    merge_gate: null,
  };
}

function localMidnightToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function localDaysAgo(days: number, hour = 12): Date {
  const d = localMidnightToday();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe('bucketTicketsByDay', () => {
  it('returns exactly `days` buckets, oldest first, ending today', () => {
    const buckets = bucketTicketsByDay([], 30);
    expect(buckets).toHaveLength(30);
    expect(buckets[29].date.getTime()).toBe(localMidnightToday().getTime());
    expect(buckets[0].date.getTime()).toBeLessThan(buckets[29].date.getTime());
  });

  it('buckets by local day, not UTC day', () => {
    // 21:00 local is the next or previous UTC day depending on the zone;
    // either way it belongs to today's local bucket.
    const buckets = bucketTicketsByDay([ticketAt(localDaysAgo(0, 21), 7)], 3);
    expect(buckets[2].count).toBe(1);
    expect(buckets[0].count + buckets[1].count).toBe(0);
  });

  it('adds up the cost of the day and drops tickets outside the window', () => {
    const buckets = bucketTicketsByDay(
      [
        ticketAt(localDaysAgo(1, 18), 20, 2.5),
        ticketAt(localDaysAgo(1, 9), 10, 1.5),
        ticketAt(localDaysAgo(9), 2, 100),
      ],
      3
    );
    expect(buckets[1].count).toBe(2);
    expect(buckets[1].cost).toBeCloseTo(4);
    expect(buckets[1].tickets.map((t) => t.issue_number)).toEqual([20, 10]);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });
});

describe('ticketsByMonth', () => {
  it('credits the override or the default hours, newest month first', () => {
    const rows = ticketsByMonth(
      [ticketAt(localDaysAgo(0), 1, 3, 6), ticketAt(localDaysAgo(0), 2, 1)],
      3,
      4
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].count).toBe(2);
    expect(rows[0].hours).toBe(10);
    expect(rows[0].cost).toBeCloseTo(4);
  });
});

/** A ticket the backend resolved on its approval: PR approved, not merged. */
function approvedAt(instant: Date, issueNumber: number, prNumber: number) {
  const ticket = ticketAt(instant, issueNumber);
  ticket.merge_gate = {
    pr_number: prNumber,
    workspace_id: 'ws1',
    approved_at: ticket.resolved_at ?? '',
  };
  return ticket;
}

describe('merge gate', () => {
  it('an approved PR without merge counts as resolved and waits for the gate', () => {
    // Today, so the monthly row holds both whatever day of the month it is.
    const approved = approvedAt(localDaysAgo(0), 30, 31);
    const tickets = [approved, ticketAt(localDaysAgo(0), 10)];
    const buckets = bucketTicketsByDay(tickets, 3);
    expect(buckets[2].count).toBe(2);
    expect(ticketsByMonth(tickets, 1, 4)[0].hours).toBe(8);
    expect(awaitingMergeTickets(tickets)).toEqual([approved]);
  });

  it('the merge leaves the gate without changing the count or the day', () => {
    const approved = approvedAt(localDaysAgo(1), 30, 31);
    // After the merge the backend keeps the approval date as resolved_at.
    const merged = { ...approved, merge_gate: null };
    const before = bucketTicketsByDay([approved], 3);
    const after = bucketTicketsByDay([merged], 3);
    expect(after.map((b) => b.count)).toEqual(before.map((b) => b.count));
    expect(after[1].count).toBe(1);
    expect(awaitingMergeTickets([merged])).toEqual([]);
  });

  it('an approval lost before the merge leaves both the count and the gate', () => {
    // Changes requested: the backend stops resolving the ticket.
    const reopened = approvedAt(localDaysAgo(1), 30, 31);
    reopened.resolved_at = null;
    reopened.merge_gate = null;
    expect(bucketTicketsByDay([reopened], 3)[1].count).toBe(0);
    expect(awaitingMergeTickets([reopened])).toEqual([]);
  });

  it('lists the longest waiting first', () => {
    const recent = approvedAt(localDaysAgo(0), 40, 41);
    const old = approvedAt(localDaysAgo(2), 50, 51);
    const ids = awaitingMergeTickets([recent, old]).map((t) => t.issue_number);
    expect(ids).toEqual([50, 40]);
  });
});

describe('parseSqliteUtc', () => {
  it('reads the API datetime as UTC', () => {
    expect(parseSqliteUtc('2026-07-25 12:00:00.000').toISOString()).toBe(
      '2026-07-25T12:00:00.000Z'
    );
  });

  it('keeps an explicit zone', () => {
    expect(parseSqliteUtc('2026-07-25T12:00:00+02:00').toISOString()).toBe(
      '2026-07-25T10:00:00.000Z'
    );
  });
});

describe('formatManHours', () => {
  it('drops trailing zeros and keeps one decimal', () => {
    expect(formatManHours(42)).toBe('42');
    expect(formatManHours(42.5)).toBe('42.5');
    expect(formatManHours(42.55)).toBe('42.6');
  });
});
