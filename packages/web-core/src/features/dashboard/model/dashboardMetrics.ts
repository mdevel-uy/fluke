import type { LucideIcon } from 'lucide-react';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';

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
