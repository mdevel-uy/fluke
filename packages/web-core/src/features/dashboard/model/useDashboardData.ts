import { useMemo } from 'react';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useCompletedTasksToday } from './useCompletedTasks';
import {
  useDashboardOverview,
  useProvidersUsage,
  useTickets,
} from './dashboardQueries';
import { parseSqliteUtc } from './dashboardMetrics';

/** Events of the activity feed other than resolved tickets. */
export type FeedEvent = {
  key: string;
  time: Date;
  kind: 'pr_opened' | 'pr_merged' | 'approval' | 'failed';
  label: string;
};

/** Window of the activity feed: today and yesterday. */
export const FEED_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Every Dashboard query in one place: the backend overview (repos, running
 * tasks, blockers), tickets, provider limits, and the live workspace stream
 * for what only it knows (context usage, approvals, PR events).
 */
export function useDashboardData() {
  const overview = useDashboardOverview();
  const { tickets } = useTickets();
  const providers = useProvidersUsage();
  const { workspaces, archivedWorkspaces, isConnected } = useWorkspaces();
  const { pendingApprovals } = useApprovals();
  const completedToday = useCompletedTasksToday();

  const workspaceById = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws])),
    [workspaces]
  );

  const conflictingPrs = useMemo(
    () =>
      workspaces.filter(
        (ws) =>
          ws.prNumber !== undefined &&
          ws.prStatus === 'open' &&
          ws.prMergeable === 'conflicting'
      ),
    [workspaces]
  );

  const approvalWorkspaces = useMemo(
    () => workspaces.filter((ws) => ws.hasPendingApproval),
    [workspaces]
  );

  const feedEvents = useMemo(() => {
    const cutoff = Date.now() - FEED_WINDOW_MS;
    const events: FeedEvent[] = [];
    for (const ws of [...workspaces, ...archivedWorkspaces]) {
      if (ws.prNumber === undefined) continue;
      const label = `#${ws.prNumber}`;
      if (ws.prCreatedAt)
        events.push({
          key: `propen-${ws.id}`,
          time: new Date(ws.prCreatedAt),
          kind: 'pr_opened',
          label,
        });
      if (ws.prMergedAt)
        events.push({
          key: `prmerged-${ws.id}`,
          time: new Date(ws.prMergedAt),
          kind: 'pr_merged',
          label,
        });
    }
    for (const approval of pendingApprovals) {
      events.push({
        key: `approval-${approval.approval_id}`,
        time: new Date(approval.created_at),
        kind: 'approval',
        label: approval.tool_name,
      });
    }
    for (const c of completedToday) {
      if (c.status !== 'failed') continue;
      events.push({
        key: `failed-${c.worker_id}-${c.completed_at}`,
        time: parseSqliteUtc(c.completed_at),
        kind: 'failed',
        label: c.issue_number != null ? `#${c.issue_number}` : c.title,
      });
    }
    return events.filter((e) => e.time.getTime() >= cutoff);
  }, [workspaces, archivedWorkspaces, pendingApprovals, completedToday]);

  return {
    overview,
    tickets,
    providers,
    isConnected,
    workspaces,
    workspaceById,
    conflictingPrs,
    approvalWorkspaces,
    feedEvents,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
