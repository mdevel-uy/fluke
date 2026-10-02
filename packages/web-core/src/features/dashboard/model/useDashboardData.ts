import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CircleAlert,
  Clock3,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import {
  useWorkerTaskIndex,
  withWorkerTaskInfo,
} from '@/features/workers/model/workerTaskInfo';
import { taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import {
  parseSqliteUtc,
  useCompletedTasksToday,
} from '@/features/dashboard/model/useCompletedTasks';
import {
  CONTEXT_CRIT_RATIO,
  contextRatio,
  FEED_MAX_ITEMS,
  FEED_WINDOW_MS,
  formatDurationSince,
  type AttentionItem,
  type FeedItem,
  type PipelineSegment,
  type PipelineSegmentKey,
} from './dashboardMetrics';

/**
 * All Dashboard data in one view model: the queries, the per-worker /
 * per-workspace indexes and every derived metric the panels render.
 */
export function useDashboardData() {
  const { t } = useTranslation('common');

  const { data: workers = [], isLoading: isWorkersLoading } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const {
    workspaces: rawWorkspaces,
    archivedWorkspaces: rawArchivedWorkspaces,
    isConnected,
  } = useWorkspaces();
  const { pendingApprovals } = useApprovals();
  const completedToday = useCompletedTasksToday();

  // Worker identity, task title, issue number and stalled-task detection are
  // not part of the workspace stream — the same overlay the sidebar applies.
  const workerTaskIndex = useWorkerTaskIndex(workers, tasks);
  const workspaces = useMemo(
    () => withWorkerTaskInfo(rawWorkspaces, workerTaskIndex),
    [rawWorkspaces, workerTaskIndex]
  );
  const archivedWorkspaces = useMemo(
    () => withWorkerTaskInfo(rawArchivedWorkspaces, workerTaskIndex),
    [rawArchivedWorkspaces, workerTaskIndex]
  );

  const workspaceById = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws])),
    [workspaces]
  );

  const { workerById, taskByWorkspaceId } = workerTaskIndex;

  const doneToday = completedToday.filter((c) => c.status === 'done').length;
  const failedToday = completedToday.filter(
    (c) => c.status === 'failed'
  ).length;

  const doneTodayByWorker = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of completedToday) {
      if (c.status !== 'done') continue;
      map.set(c.worker_id, (map.get(c.worker_id) ?? 0) + 1);
    }
    return map;
  }, [completedToday]);

  const pipeline = useMemo(() => {
    const counts = { queued: 0, in_progress: 0, in_review: 0 };
    for (const task of tasks) {
      // `approved` is a substate of "PR still open" (#464). The pipeline
      // widget stays a 3-bucket view — fold approved into in_review so the
      // total for "still on the board" stays stable.
      // waiting_user (#662) counts as in_progress.
      const bucket =
        task.status === 'approved'
          ? 'in_review'
          : task.status === 'waiting_user'
            ? 'in_progress'
            : task.status;
      if (bucket in counts) {
        counts[bucket as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [tasks]);

  const activeTaskByWorkerId = useMemo(() => {
    const map = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (task.status === 'in_progress' || task.status === 'waiting_user')
        map.set(task.worker_id, task);
    }
    return map;
  }, [tasks]);

  const nextQueuedTask = useMemo(() => {
    const queued = tasks.filter((task) => task.status === 'queued');
    queued.sort((a, b) => a.position - b.position);
    return queued[0];
  }, [tasks]);

  const reposInProgress = useMemo(() => {
    const repos = new Set<string>();
    for (const task of tasks) {
      if (task.status === 'in_progress' || task.status === 'waiting_user')
        repos.add(task.repo_id);
    }
    return repos.size;
  }, [tasks]);

  const openPrs = useMemo(
    () =>
      workspaces.filter(
        (ws) => ws.prNumber !== undefined && ws.prStatus === 'open'
      ),
    [workspaces]
  );

  const oldestApprovalWait = useMemo(() => {
    if (pendingApprovals.length === 0) return null;
    const oldest = pendingApprovals.reduce((a, b) =>
      new Date(a.created_at).getTime() <= new Date(b.created_at).getTime()
        ? a
        : b
    );
    return formatDurationSince(oldest.created_at);
  }, [pendingApprovals]);

  const attentionItems = useMemo(() => {
    const items: AttentionItem[] = [];
    for (const ws of workspaces) {
      const workerLabel = ws.workerName || ws.name;
      if (ws.hasPendingApproval) {
        const soleApproval =
          pendingApprovals.length === 1 ? pendingApprovals[0] : null;
        const base = soleApproval
          ? soleApproval.tool_name
          : ws.taskTitle || ws.branch;
        items.push({
          key: `approval-${ws.id}`,
          icon: Clock3,
          tone: 'warning',
          title: t('dashboard.approvalPending', { worker: workerLabel }),
          meta: oldestApprovalWait
            ? `${base} · ${t('dashboard.waitingFor', { time: oldestApprovalWait })}`
            : base,
          action: t('dashboard.actionReview'),
          workspaceId: ws.id,
        });
      }
      if (ws.prStatus === 'open' && ws.prMergeable === 'conflicting') {
        items.push({
          key: `conflict-${ws.id}`,
          icon: AlertTriangle,
          tone: 'error',
          title: t('dashboard.prConflict', { number: ws.prNumber }),
          meta:
            ws.filesChanged !== undefined
              ? `${ws.branch} · ${t('workspaces.filesChanged', { count: ws.filesChanged })}`
              : ws.branch,
          action: t('dashboard.actionOpen'),
          workspaceId: ws.id,
        });
      }
      const ratio = contextRatio(ws);
      if (ratio !== null && ratio >= CONTEXT_CRIT_RATIO) {
        items.push({
          key: `context-${ws.id}`,
          icon: CircleAlert,
          tone: 'error',
          title: t('dashboard.highContext', {
            name: workerLabel,
            pct: Math.round(ratio * 100),
          }),
          meta: t('dashboard.compactionLikely'),
          action: t('dashboard.actionView'),
          workspaceId: ws.id,
        });
      }
      if (ws.hasStalledTask) {
        const since = ws.latestProcessCompletedAt
          ? ` · ${formatDurationSince(ws.latestProcessCompletedAt)}`
          : '';
        items.push({
          key: `stalled-${ws.id}`,
          icon: PauseCircle,
          tone: 'warning',
          title: t('dashboard.taskStalled', { name: workerLabel }),
          meta: `${ws.taskTitle || ws.branch}${since}`,
          action: t('dashboard.actionNudge'),
          workspaceId: ws.id,
        });
      }
      if (ws.latestProcessStatus === 'failed') {
        items.push({
          key: `failed-${ws.id}`,
          icon: XCircle,
          tone: 'error',
          title: t('dashboard.processFailed', { name: workerLabel }),
          meta: ws.taskTitle || ws.branch,
          action: t('dashboard.actionOpen'),
          workspaceId: ws.id,
        });
      }
    }
    return items;
  }, [workspaces, pendingApprovals, oldestApprovalWait, t]);

  const stats = useMemo(() => {
    const activeWorkers = workers.filter((w) => w.active_workspace_id !== null);
    const runningNames = activeWorkers
      .filter((w) => {
        const ws = w.active_workspace_id
          ? workspaceById.get(w.active_workspace_id)
          : undefined;
        return ws?.isRunning || ws?.latestProcessStatus === 'running';
      })
      .map((w) => w.name);
    const conflicting = openPrs.filter(
      (ws) => ws.prMergeable === 'conflicting'
    ).length;
    return {
      active: activeWorkers.length,
      total: workers.length,
      runningNames,
      conflicting,
      approvals: pendingApprovals.length,
    };
  }, [workers, workspaceById, openPrs, pendingApprovals]);

  const feedItems = useMemo(() => {
    const cutoff = Date.now() - FEED_WINDOW_MS;
    const items: FeedItem[] = [];

    for (const c of completedToday) {
      const worker = workerById.get(c.worker_id);
      const label =
        c.issue_number != null ? `#${c.issue_number}` : `«${c.title}»`;
      items.push({
        key: `done-${c.worker_id}-${c.completed_at}-${c.title}`,
        time: parseSqliteUtc(c.completed_at),
        tone: c.status === 'failed' ? 'error' : 'success',
        text:
          c.status === 'failed'
            ? t('dashboard.feedTaskFailed', { task: label })
            : t('dashboard.feedTaskDone', {
                worker: worker?.name ?? '—',
                task: label,
              }),
      });
    }

    for (const ws of [...workspaces, ...archivedWorkspaces]) {
      const workerLabel = ws.workerName || ws.name;
      if (ws.prNumber !== undefined && ws.prCreatedAt) {
        items.push({
          key: `propen-${ws.id}`,
          time: new Date(ws.prCreatedAt),
          tone: 'success',
          text: t('dashboard.feedPrOpened', {
            worker: workerLabel,
            number: ws.prNumber,
          }),
        });
      }
      if (ws.prNumber !== undefined && ws.prMergedAt) {
        items.push({
          key: `prmerged-${ws.id}`,
          time: new Date(ws.prMergedAt),
          tone: 'merged',
          text: t('dashboard.feedPrMerged', { number: ws.prNumber }),
        });
      }
    }

    for (const approval of pendingApprovals) {
      items.push({
        key: `approval-${approval.approval_id}`,
        time: new Date(approval.created_at),
        tone: 'warning',
        text: t('dashboard.feedApprovalRequested', {
          tool: approval.tool_name,
        }),
      });
    }

    for (const [workerId, task] of activeTaskByWorkerId) {
      const ws = task.workspace_id
        ? workspaceById.get(task.workspace_id)
        : undefined;
      if (!ws?.latestProcessStartedAt) continue;
      items.push({
        key: `started-${workerId}-${task.id}`,
        time: new Date(ws.latestProcessStartedAt),
        tone: 'brand',
        text: t('dashboard.feedTaskStarted', {
          worker: workerById.get(workerId)?.name ?? '—',
          task: taskDisplayTitle(task),
        }),
      });
    }

    return items
      .filter((item) => item.time.getTime() >= cutoff)
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, FEED_MAX_ITEMS);
  }, [
    completedToday,
    workspaces,
    archivedWorkspaces,
    pendingApprovals,
    activeTaskByWorkerId,
    workspaceById,
    workerById,
    t,
  ]);

  const pipelineTotal =
    pipeline.queued +
    pipeline.in_progress +
    pipeline.in_review +
    doneToday +
    failedToday;

  const pipelineSegments: PipelineSegment[] = [
    { key: 'queued', count: pipeline.queued, color: 'bg-md-outline' },
    { key: 'inProgress', count: pipeline.in_progress, color: 'bg-brand' },
    { key: 'inReview', count: pipeline.in_review, color: 'bg-warning' },
    { key: 'done', count: doneToday, color: 'bg-success' },
    { key: 'failed', count: failedToday, color: 'bg-error' },
  ];

  const pipelineLabels: Record<PipelineSegmentKey, string> = {
    queued: t('dashboard.queued'),
    inProgress: t('dashboard.inProgress'),
    inReview: t('dashboard.inReview'),
    done: t('dashboard.done'),
    failed: t('dashboard.failed'),
  };

  return {
    workers,
    isWorkersLoading,
    workspaces,
    isConnected,
    workspaceById,
    taskByWorkspaceId,
    activeTaskByWorkerId,
    doneToday,
    failedToday,
    doneTodayByWorker,
    pipeline,
    nextQueuedTask,
    reposInProgress,
    openPrs,
    oldestApprovalWait,
    attentionItems,
    stats,
    feedItems,
    pipelineTotal,
    pipelineSegments,
    pipelineLabels,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
