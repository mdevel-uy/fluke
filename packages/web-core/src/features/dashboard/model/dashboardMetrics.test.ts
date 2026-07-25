import { describe, it, expect } from 'vitest';
import {
  bucketClosedIssuesByDay,
  formatManHours,
  parseSqliteUtc,
} from './dashboardMetrics';
import type { ClosedIssue } from './useClosedIssues';

/**
 * Render an instant the way the API does: UTC, "YYYY-MM-DD HH:MM:SS.SSS".
 *
 * Tests build their inputs from local `Date`s and convert here, so assertions
 * about local-day bucketing hold in any timezone the suite runs in.
 */
function sqliteUtcFor(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}

function issueAt(instant: Date, number: number, title = 'issue'): ClosedIssue {
  return {
    repo_id: 'r1',
    number,
    title,
    closed_at: sqliteUtcFor(instant),
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

describe('bucketClosedIssuesByDay', () => {
  it('returns exactly `days` buckets, oldest first, ending today', () => {
    const buckets = bucketClosedIssuesByDay([], 30);
    expect(buckets).toHaveLength(30);
    expect(buckets[29].date.getTime()).toBe(localMidnightToday().getTime());
    expect(buckets[0].date.getTime()).toBeLessThan(buckets[29].date.getTime());
  });

  it('fills quiet days with zero instead of omitting them', () => {
    const buckets = bucketClosedIssuesByDay([issueAt(localDaysAgo(0), 1)], 7);
    expect(buckets).toHaveLength(7);
    expect(buckets.slice(0, 6).every((b) => b.count === 0)).toBe(true);
    expect(buckets[6].count).toBe(1);
  });

  it('buckets by local day, not UTC day', () => {
    // 21:00 local is already the next day in UTC east of Greenwich and the
    // previous day west of it; either way it belongs to today's local bucket.
    const lateToday = localDaysAgo(0, 21);
    const buckets = bucketClosedIssuesByDay([issueAt(lateToday, 7)], 3);
    const today = localMidnightToday();
    const expectedKey = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');

    expect(buckets[2].dayKey).toBe(expectedKey);
    expect(buckets[2].count).toBe(1);
    expect(buckets[0].count + buckets[1].count).toBe(0);
  });

  it('drops closures outside the window', () => {
    // The API over-fetches by a day, so out-of-window rows do arrive.
    const buckets = bucketClosedIssuesByDay(
      [issueAt(localDaysAgo(0), 1), issueAt(localDaysAgo(9), 2)],
      7
    );
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('groups several closures on one day and keeps API order', () => {
    const day = localDaysAgo(1);
    const later = new Date(day);
    later.setHours(18);
    const buckets = bucketClosedIssuesByDay(
      // Newest first, as the endpoint returns them.
      [issueAt(later, 20, 'later'), issueAt(day, 10, 'earlier')],
      3
    );
    expect(buckets[1].count).toBe(2);
    expect(buckets[1].issues.map((i) => i.number)).toEqual([20, 10]);
  });

  it('handles an empty window', () => {
    expect(bucketClosedIssuesByDay([], 1)).toHaveLength(1);
    expect(bucketClosedIssuesByDay([], 1)[0].count).toBe(0);
  });
});

describe('parseSqliteUtc', () => {
  it('reads the API datetime as UTC', () => {
    expect(parseSqliteUtc('2026-07-25 12:00:00.000').toISOString()).toBe(
      '2026-07-25T12:00:00.000Z'
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
