import type { LucideIcon } from 'lucide-react';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { ResolvedTask } from './useResolvedTasks';

/** Shared thresholds: context usage and Claude plan meters use the same scale. */
export const METER_WARN_RATIO = 0.7;
export const METER_CRIT_RATIO = 0.9;

export const CONTEXT_WARN_RATIO = METER_WARN_RATIO;
export const CONTEXT_CRIT_RATIO = METER_CRIT_RATIO;

export function contextRatio(ws: SidebarWorkspace | undefined): number | null {
  if (!ws?.contextUsage || ws.contextUsage.contextWindow <= 0) return null;
  return Math.min(
    1,
    ws.contextUsage.totalTokens / ws.contextUsage.contextWindow
  );
}

/** 183000 -> "183k" */
export function formatTokensK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/** Compact elapsed since a timestamp: 45s, 6m, 3h, 2d */
export function formatDurationSince(dateString: string): string {
  const diffSecs = Math.max(
    0,
    Math.floor((Date.now() - new Date(dateString).getTime()) / 1000)
  );
  if (diffSecs < 60) return `${diffSecs}s`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

/** Parse the SQLite UTC datetime returned by the API into a Date. */
export function parseSqliteUtc(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

export type ResolvedTaskDay = {
  /** Local calendar day, "YYYY-MM-DD". */
  dayKey: string;
  /** Local midnight of that day, for axis formatting. */
  date: Date;
  count: number;
  /** Tasks completed that day, newest first. */
  tasks: { issueNumber: number | null; title: string }[];
};

/** Local calendar day of a timestamp -- not `toISOString`, which is UTC. */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Group resolved tasks into one bucket per local calendar day, oldest first,
 * covering exactly `days` days up to and including today.
 *
 * Days with no completions become `count: 0` buckets rather than being omitted,
 * so the chart's x-axis stays a real calendar instead of skipping quiet days.
 * The API deliberately over-fetches by a day, so anything landing outside the
 * window after local-time conversion is dropped here.
 */
export function bucketResolvedTasksByDay(
  tasks: ResolvedTask[],
  days: number
): ResolvedTaskDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets: ResolvedTaskDay[] = [];
  const byDay = new Map<string, ResolvedTaskDay>();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const bucket: ResolvedTaskDay = {
      dayKey: localDayKey(date),
      date,
      count: 0,
      tasks: [],
    };
    buckets.push(bucket);
    byDay.set(bucket.dayKey, bucket);
  }

  for (const task of tasks) {
    const bucket = byDay.get(localDayKey(parseSqliteUtc(task.completed_at)));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.tasks.push({ issueNumber: task.issue_number, title: task.title });
  }

  return buckets;
}

/**
 * Format an hours figure for display, without a unit -- the caller appends a
 * translated one. Keeps at most one decimal so `2.5 h/issue` stays readable.
 */
export function formatManHours(hours: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(hours);
}

export type AttentionTone = 'warning' | 'error';

export type AttentionItem = {
  key: string;
  icon: LucideIcon;
  tone: AttentionTone;
  title: string;
  meta: string;
  action: string;
  workspaceId: string;
};

export type FeedTone =
  | 'success'
  | 'warning'
  | 'error'
  | 'brand'
  | 'merged'
  | 'muted';

export type FeedItem = {
  key: string;
  time: Date;
  tone: FeedTone;
  text: string;
};

export const FEED_DOT_CLASS: Record<FeedTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  brand: 'bg-brand-on-surface',
  merged: 'bg-merged',
  muted: 'bg-md-outline',
};

export const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FEED_MAX_ITEMS = 8;

export type PipelineSegmentKey =
  | 'queued'
  | 'inProgress'
  | 'inReview'
  | 'done'
  | 'failed';

export type PipelineSegment = {
  key: PipelineSegmentKey;
  count: number;
  color: string;
};
