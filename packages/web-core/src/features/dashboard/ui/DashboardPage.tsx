import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CircleAlert,
  Clock3,
  GitPullRequest,
  Loader2,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import { IssueBadge, taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import {
  parseSqliteUtc,
  useCompletedTasksToday,
} from '@/features/dashboard/model/useCompletedTasks';
import { cn } from '@/shared/lib/utils';
import {
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '@/features/workers/model/chipColors';

const CONTEXT_WARN_RATIO = 0.7;
const CONTEXT_CRIT_RATIO = 0.9;

function contextRatio(ws: SidebarWorkspace | undefined): number | null {
  if (!ws?.contextUsage || ws.contextUsage.contextWindow <= 0) return null;
  return Math.min(
    1,
    ws.contextUsage.totalTokens / ws.contextUsage.contextWindow
  );
}

/** 183000 -> "183k" */
function formatTokensK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/** 12400 -> "12.4K", 1_200_000 -> "1.2M" */
function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}K`;
  }
  return `${tokens}`;
}

/** Compact elapsed since a timestamp: 45s, 6m, 3h, 2d */
function formatDurationSince(dateString: string): string {
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

function SubDot({ tone }: { tone: 'success' | 'error' }) {
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'success' ? 'bg-success' : 'bg-error'
      )}
      aria-hidden
    />
  );
}

function StatCard({
  label,
  value,
  suffix,
  sub,
  tone,
}: {
  label: string;
  value: number;
  suffix?: string;
  sub?: React.ReactNode;
  tone?: 'warning' | 'error';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-xl border bg-md-surface-container-lowest p-3.5 shadow-soft',
        tone === 'warning' && value > 0
          ? 'border-warning/40'
          : tone === 'error' && value > 0
            ? 'border-error/40'
            : 'border-border/60'
      )}
    >
      <span className="font-sans text-label uppercase tracking-wide text-low">
        {label}
      </span>
      <span className="font-sans text-heading leading-none text-high tabular-nums">
        {value}
        {suffix && (
          <span className="text-sm font-normal text-low"> {suffix}</span>
        )}
      </span>
      <span className="flex min-h-4 items-center gap-1.5 truncate text-[11px] text-low">
        {sub}
      </span>
    </div>
  );
}

function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'error' | 'info' | 'muted';
  label: string;
  pulse?: boolean;
}) {
  const toneClasses = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
    info: 'bg-info/10 text-info',
    muted: 'bg-secondary text-low',
  } as const;
  const dotClasses = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    info: 'bg-info',
    muted: 'bg-md-outline',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
        toneClasses[tone]
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          dotClasses[tone],
          pulse && 'animate-pulse motion-reduce:animate-none'
        )}
      />
      {label}
    </span>
  );
}

function ContextBar({ ws }: { ws: SidebarWorkspace | undefined }) {
  const { t } = useTranslation('common');
  const ratio = contextRatio(ws);
  const pct = ratio === null ? 0 : Math.round(ratio * 100);
  const barColor =
    ratio === null
      ? 'bg-md-outline'
      : ratio >= CONTEXT_CRIT_RATIO
        ? 'bg-error'
        : ratio >= CONTEXT_WARN_RATIO
          ? 'bg-warning'
          : 'bg-success';
  const usage = ws?.contextUsage;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-low">
        <span>{t('dashboard.context')}</span>
        <span className="tabular-nums">
          {ratio === null || !usage
            ? '—'
            : `${formatTokensK(usage.totalTokens)} / ${formatTokensK(usage.contextWindow)} · ${pct}%`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-md-outline-variant/60">
        <div
          className={cn('h-full rounded-full', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TokenBreakdown({ ws }: { ws: SidebarWorkspace | undefined }) {
  const { t } = useTranslation('common');
  const usage = ws?.contextUsage;
  const dash = t('dashboard.tokensNone');

  const parts: Array<{
    key: string;
    short: string;
    label: string;
    value: number | null | undefined;
  }> = [
    {
      key: 'in',
      short: t('dashboard.tokensInputShort'),
      label: t('dashboard.tokensInputLabel'),
      value: usage?.inputTokens ?? null,
    },
    {
      key: 'out',
      short: t('dashboard.tokensOutputShort'),
      label: t('dashboard.tokensOutputLabel'),
      value: usage?.outputTokens ?? null,
    },
  ];
  if (usage?.cacheCreationInputTokens != null) {
    parts.push({
      key: 'cache-write',
      short: t('dashboard.tokensCacheWriteShort'),
      label: t('dashboard.tokensCacheWriteLabel'),
      value: usage.cacheCreationInputTokens,
    });
  }
  if (usage?.cacheReadInputTokens != null) {
    parts.push({
      key: 'cache-read',
      short: t('dashboard.tokensCacheReadShort'),
      label: t('dashboard.tokensCacheReadLabel'),
      value: usage.cacheReadInputTokens,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-low">
      <span className="uppercase tracking-wide">{t('dashboard.tokens')}</span>
      {parts.map((part, idx) => (
        <span
          key={part.key}
          className="flex items-center gap-1 tabular-nums"
          title={part.label}
        >
          {idx > 0 && <span className="text-md-outline">·</span>}
          <span>{part.short}</span>
          <span className="font-medium text-normal">
            {part.value == null ? dash : formatTokensCompact(part.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

function SectionTitle({
  children,
  chip,
}: {
  children: React.ReactNode;
  chip?: React.ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2 font-sans text-label font-semibold uppercase tracking-wide text-low">
      {children}
      {chip !== undefined && (
        <span className="rounded-full bg-secondary px-2 py-px text-[10px] font-semibold normal-case tracking-normal text-normal tabular-nums">
          {chip}
        </span>
      )}
    </h2>
  );
}

type AttentionTone = 'warning' | 'error';

type AttentionItem = {
  key: string;
  icon: LucideIcon;
  tone: AttentionTone;
  title: string;
  meta: string;
  action: string;
  workspaceId: string;
};

type FeedTone = 'success' | 'warning' | 'error' | 'brand' | 'merged' | 'muted';

type FeedItem = {
  key: string;
  time: Date;
  tone: FeedTone;
  text: string;
};

const FEED_DOT_CLASS: Record<FeedTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  brand: 'bg-brand-on-surface',
  merged: 'bg-merged',
  muted: 'bg-md-outline',
};

const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const FEED_MAX_ITEMS = 8;

export function DashboardPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('dashboard.title'));
  const appNavigation = useAppNavigation();

  const { data: workers = [], isLoading: isWorkersLoading } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const { workspaces, archivedWorkspaces, isConnected } = useWorkspaces();
  const { pendingApprovals } = useApprovals();
  const completedToday = useCompletedTasksToday();
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const setAutoIngest = useAutoIngestStore((s) => s.setAutoIngest);

  // "updated Xs ago" ticker: stamp when workspace data changes, rerender every 5s
  const lastUpdatedRef = useRef<number>(Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    lastUpdatedRef.current = Date.now();
  }, [workspaces]);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const updatedAgoSecs = Math.max(
    0,
    Math.round((Date.now() - lastUpdatedRef.current) / 1000)
  );
  const updatedAgoLabel =
    updatedAgoSecs < 60
      ? `${updatedAgoSecs}s`
      : `${Math.floor(updatedAgoSecs / 60)}m`;

  const workspaceById = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws])),
    [workspaces]
  );

  const workerById = useMemo(
    () => new Map(workers.map((w) => [w.id, w])),
    [workers]
  );

  const taskByWorkspaceId = useMemo(() => {
    const map = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (task.workspace_id) map.set(task.workspace_id, task);
    }
    return map;
  }, [tasks]);

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
      if (task.status in counts) {
        counts[task.status as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [tasks]);

  const activeTaskByWorkerId = useMemo(() => {
    const map = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (task.status === 'in_progress') map.set(task.worker_id, task);
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
      if (task.status === 'in_progress') repos.add(task.repo_id);
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

  const pipelineSegments = [
    { key: 'queued', count: pipeline.queued, color: 'bg-md-outline' },
    { key: 'inProgress', count: pipeline.in_progress, color: 'bg-brand' },
    { key: 'inReview', count: pipeline.in_review, color: 'bg-warning' },
    { key: 'done', count: doneToday, color: 'bg-success' },
    { key: 'failed', count: failedToday, color: 'bg-error' },
  ] as const;

  const pipelineLabels: Record<string, string> = {
    queued: t('dashboard.queued'),
    inProgress: t('dashboard.inProgress'),
    inReview: t('dashboard.inReview'),
    done: t('dashboard.done'),
    failed: t('dashboard.failed'),
  };

  if (isWorkersLoading && workers.length === 0 && workspaces.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-md-background">
        <Loader2
          className="h-5 w-5 animate-spin text-brand-on-surface"
          strokeWidth={1.75}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-md-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-md-outline-variant bg-md-surface-bright px-container-padding">
        <h1 className="font-sans text-heading text-high">
          {t('dashboard.title')}
        </h1>
        {isConnected && (
          <span className="flex items-center gap-1.5 text-xs text-low">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" />
            {t('dashboard.live')} ·{' '}
            {t('dashboard.updatedAgo', { time: updatedAgoLabel })}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-normal">
          {t('dashboard.autoIngest')}
          <button
            type="button"
            role="switch"
            aria-checked={autoIngest}
            onClick={() => setAutoIngest(!autoIngest)}
            className={cn(
              'relative h-[18px] w-8 rounded-full transition-colors',
              autoIngest ? 'bg-brand' : 'bg-md-outline-variant'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
                autoIngest ? 'right-0.5' : 'left-0.5'
              )}
            />
          </button>
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-container-padding py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <section
            aria-label={t('dashboard.title')}
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
          >
            <StatCard
              label={t('dashboard.workersActive')}
              value={stats.active}
              suffix={`/ ${stats.total}`}
              sub={
                stats.runningNames.length > 0 && (
                  <>
                    <SubDot tone="success" />
                    <span className="truncate">
                      {t('dashboard.runningSub', {
                        names: stats.runningNames.join(' · '),
                      })}
                    </span>
                  </>
                )
              }
            />
            <StatCard
              label={t('dashboard.inProgress')}
              value={pipeline.in_progress}
              sub={
                reposInProgress > 0 &&
                t('dashboard.acrossRepos', { count: reposInProgress })
              }
            />
            <StatCard
              label={t('dashboard.queued')}
              value={pipeline.queued}
              sub={
                nextQueuedTask &&
                t('dashboard.nextUp', {
                  label:
                    nextQueuedTask.issue_number != null
                      ? `#${nextQueuedTask.issue_number}`
                      : taskDisplayTitle(nextQueuedTask),
                })
              }
            />
            <StatCard
              label={t('dashboard.openPrs')}
              value={openPrs.length}
              tone={stats.conflicting > 0 ? 'error' : undefined}
              sub={
                stats.conflicting > 0 && (
                  <>
                    <SubDot tone="error" />
                    {t('dashboard.conflictingCount', {
                      count: stats.conflicting,
                    })}
                  </>
                )
              }
            />
            <StatCard
              label={t('dashboard.approvals')}
              value={stats.approvals}
              tone="warning"
              sub={
                oldestApprovalWait &&
                t('dashboard.waitingFor', { time: oldestApprovalWait })
              }
            />
            <StatCard
              label={t('dashboard.doneToday')}
              value={doneToday}
              sub={
                failedToday > 0 && (
                  <>
                    <SubDot tone="error" />
                    {t('dashboard.failedCount', { count: failedToday })}
                  </>
                )
              }
            />
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle>{t('dashboard.workersSection')}</SectionTitle>
            {workers.length === 0 ? (
              <p className="text-sm text-low">{t('dashboard.noWorkers')}</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {workers.map((worker) => {
                  const ws = worker.active_workspace_id
                    ? workspaceById.get(worker.active_workspace_id)
                    : undefined;
                  const isRunning = Boolean(
                    ws?.isRunning || ws?.latestProcessStatus === 'running'
                  );
                  const activeTask = activeTaskByWorkerId.get(worker.id);
                  const taskTitle = activeTask
                    ? taskDisplayTitle(activeTask)
                    : ws?.taskTitle;
                  const issueNumber = activeTask?.issue_number ?? undefined;
                  const startedAt = ws?.latestProcessStartedAt;
                  return (
                    <article
                      key={worker.id}
                      className={cn(
                        'flex flex-col gap-3 rounded-xl border border-border/60 bg-md-surface-container-lowest p-3.5 shadow-soft',
                        ws &&
                          'cursor-pointer transition-shadow hover:shadow-card'
                      )}
                      onClick={
                        ws
                          ? () => appNavigation.goToWorkspace(ws.id)
                          : undefined
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-high">
                          {worker.name}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            ROLE_CHIP_CLASS[worker.role ?? ''] ??
                              ROLE_CHIP_FALLBACK
                          )}
                        >
                          {worker.role}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {isRunning ? (
                            <StatusPill
                              tone="success"
                              pulse
                              label={
                                startedAt
                                  ? `${t('dashboard.running')} · ${formatDurationSince(startedAt)}`
                                  : t('dashboard.running')
                              }
                            />
                          ) : (
                            <StatusPill
                              tone="muted"
                              label={t('dashboard.idle')}
                            />
                          )}
                        </span>
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        {issueNumber !== undefined && (
                          <IssueBadge issueNumber={issueNumber} />
                        )}
                        <p
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            taskTitle ? 'text-normal' : 'text-low'
                          )}
                        >
                          {taskTitle ?? t('dashboard.noActiveTask')}
                        </p>
                      </div>
                      <ContextBar ws={ws} />
                      <TokenBreakdown ws={ws} />
                      <div className="flex items-center gap-4 border-t border-border/60 pt-2.5 text-xs text-low">
                        <span>
                          {t('dashboard.queue')}{' '}
                          <span className="font-semibold text-normal tabular-nums">
                            {worker.queued_count}
                          </span>
                        </span>
                        <span>
                          {t('dashboard.doneToday')}{' '}
                          <span className="font-semibold text-normal tabular-nums">
                            {doneTodayByWorker.get(worker.id) ?? 0}
                          </span>
                        </span>
                        {ws && (
                          <span className="ml-auto truncate font-mono text-[11px]">
                            {ws.branch}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle chip={t('dashboard.pipelineHint')}>
              {t('dashboard.pipelineSection')}
            </SectionTitle>
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-md-surface-container-lowest p-3.5 shadow-soft">
              {pipelineTotal > 0 && (
                <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
                  {pipelineSegments
                    .filter((segment) => segment.count > 0)
                    .map((segment) => (
                      <div
                        key={segment.key}
                        className={segment.color}
                        style={{
                          width: `${(segment.count / pipelineTotal) * 100}%`,
                        }}
                      />
                    ))}
                </div>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-normal">
                {pipelineSegments.map((segment) => (
                  <span key={segment.key} className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-sm', segment.color)} />
                    {pipelineLabels[segment.key]}{' '}
                    <span className="font-semibold text-high tabular-nums">
                      {segment.count}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <section className="flex flex-col gap-3">
              <SectionTitle
                chip={t('dashboard.openCount', { count: openPrs.length })}
              >
                {t('dashboard.prsSection')}
              </SectionTitle>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
                {openPrs.length === 0 ? (
                  <p className="p-4 text-sm text-low">
                    {t('dashboard.prsEmpty')}
                  </p>
                ) : (
                  openPrs.map((ws) => {
                    const task = taskByWorkspaceId.get(ws.id);
                    return (
                      <button
                        key={ws.id}
                        type="button"
                        onClick={() => appNavigation.goToWorkspace(ws.id)}
                        className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left last:border-b-0 hover:bg-secondary"
                      >
                        <GitPullRequest
                          className="h-4 w-4 shrink-0 text-low"
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-high">
                            <span className="tabular-nums">#{ws.prNumber}</span>{' '}
                            · {ws.taskTitle || ws.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-3 text-[11px] text-low">
                            <span className="truncate font-mono">
                              {ws.branch}
                            </span>
                            {(ws.linesAdded !== undefined ||
                              ws.linesRemoved !== undefined) && (
                              <span className="shrink-0 tabular-nums">
                                <span className="text-success">
                                  +{ws.linesAdded ?? 0}
                                </span>{' '}
                                <span className="text-error">
                                  −{ws.linesRemoved ?? 0}
                                </span>
                              </span>
                            )}
                          </span>
                        </span>
                        {ws.prMergeable === 'conflicting' ? (
                          <StatusPill
                            tone="error"
                            label={t('dashboard.conflicting')}
                          />
                        ) : ws.prMergeable === 'mergeable' ? (
                          <StatusPill
                            tone="success"
                            label={t('dashboard.mergeable')}
                          />
                        ) : task?.status === 'in_review' ? (
                          <StatusPill
                            tone="info"
                            label={t('dashboard.inReview')}
                          />
                        ) : (
                          <StatusPill
                            tone="muted"
                            label={t('dashboard.openPill')}
                          />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <SectionTitle chip={attentionItems.length}>
                {t('dashboard.attentionSection')}
              </SectionTitle>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
                {attentionItems.length === 0 ? (
                  <p className="p-4 text-sm text-low">
                    {t('dashboard.attentionEmpty')}
                  </p>
                ) : (
                  attentionItems.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() =>
                        appNavigation.goToWorkspace(item.workspaceId)
                      }
                      className="group flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left last:border-b-0 hover:bg-secondary"
                    >
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                          item.tone === 'error'
                            ? 'bg-error/10 text-error'
                            : 'bg-warning/10 text-warning'
                        )}
                      >
                        <item.icon className="h-4 w-4" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-high">
                          {item.title}
                        </span>
                        <span className="block truncate text-[11px] text-low">
                          {item.meta}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-brand-on-surface group-hover:underline">
                        {item.action}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="flex flex-col gap-3">
            <SectionTitle>{t('dashboard.activitySection')}</SectionTitle>
            <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
              {feedItems.length === 0 ? (
                <p className="p-4 text-sm text-low">
                  {t('dashboard.activityEmpty')}
                </p>
              ) : (
                feedItems.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm last:border-b-0"
                  >
                    <span className="w-11 shrink-0 text-[11px] text-low tabular-nums">
                      {item.time.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        FEED_DOT_CLASS[item.tone]
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-normal">
                      {item.text}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
