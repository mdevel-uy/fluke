import { useMemo } from 'react';
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
import { formatRelativeTime } from '@/shared/lib/date';
import { cn } from '@/shared/lib/utils';

const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-brand/10 text-brand-on-surface',
  reviewer: 'bg-warning/10 text-warning',
};

const CONTEXT_WARN_RATIO = 0.7;
const CONTEXT_CRIT_RATIO = 0.9;

function contextRatio(ws: SidebarWorkspace | undefined): number | null {
  if (!ws?.contextUsage || ws.contextUsage.contextWindow <= 0) return null;
  return Math.min(
    1,
    ws.contextUsage.totalTokens / ws.contextUsage.contextWindow
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning' | 'error';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border bg-md-surface-container-lowest p-3.5 shadow-soft',
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
      </span>
    </div>
  );
}

function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'error' | 'muted';
  label: string;
  pulse?: boolean;
}) {
  const toneClasses = {
    success: 'border-success/40 text-success',
    warning: 'border-warning/40 text-warning',
    error: 'border-error/40 text-error',
    muted: 'border-border text-low',
  } as const;
  const dotClasses = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    muted: 'bg-md-outline',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
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

function ContextBar({ ratio }: { ratio: number | null }) {
  const { t } = useTranslation('common');
  const pct = ratio === null ? 0 : Math.round(ratio * 100);
  const barColor =
    ratio === null
      ? 'bg-md-outline'
      : ratio >= CONTEXT_CRIT_RATIO
        ? 'bg-error'
        : ratio >= CONTEXT_WARN_RATIO
          ? 'bg-warning'
          : 'bg-success';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-low">
        <span>{t('dashboard.context')}</span>
        <span className="tabular-nums">{ratio === null ? '—' : `${pct}%`}</span>
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-sans text-label font-semibold uppercase tracking-wide text-low">
      {children}
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
  workspaceId: string;
};

export function DashboardPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('dashboard.title'));
  const appNavigation = useAppNavigation();

  const { data: workers = [], isLoading: isWorkersLoading } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const { workspaces, isConnected } = useWorkspaces();
  const { pendingApprovals } = useApprovals();

  const workspaceById = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws])),
    [workspaces]
  );

  const pipeline = useMemo(() => {
    const counts = {
      queued: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      failed: 0,
    };
    for (const task of tasks) {
      if (task.status in counts) {
        counts[task.status as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [tasks]);

  const activeTaskByWorkerId = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      if (task.status === 'in_progress') map.set(task.worker_id, task.title);
    }
    return map;
  }, [tasks]);

  const openPrs = useMemo(
    () =>
      workspaces.filter(
        (ws) => ws.prNumber !== undefined && ws.prStatus === 'open'
      ),
    [workspaces]
  );

  const attentionItems = useMemo(() => {
    const items: AttentionItem[] = [];
    for (const ws of workspaces) {
      const workerLabel = ws.workerName || ws.name;
      if (ws.hasPendingApproval) {
        items.push({
          key: `approval-${ws.id}`,
          icon: Clock3,
          tone: 'warning',
          title: t('dashboard.approvalPending', { worker: workerLabel }),
          meta: ws.taskTitle || ws.branch,
          workspaceId: ws.id,
        });
      }
      if (ws.prStatus === 'open' && ws.prMergeable === 'conflicting') {
        items.push({
          key: `conflict-${ws.id}`,
          icon: AlertTriangle,
          tone: 'error',
          title: t('dashboard.prConflict', { number: ws.prNumber }),
          meta: ws.branch,
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
          meta: ws.taskTitle || ws.branch,
          workspaceId: ws.id,
        });
      }
      if (ws.hasStalledTask) {
        items.push({
          key: `stalled-${ws.id}`,
          icon: PauseCircle,
          tone: 'warning',
          title: t('dashboard.taskStalled', { name: workerLabel }),
          meta: ws.taskTitle || ws.branch,
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
          workspaceId: ws.id,
        });
      }
    }
    return items;
  }, [workspaces, t]);

  const stats = useMemo(() => {
    const active = workers.filter((w) => w.active_workspace_id !== null).length;
    const conflicting = openPrs.filter(
      (ws) => ws.prMergeable === 'conflicting'
    ).length;
    return {
      active,
      total: workers.length,
      conflicting,
      approvals: pendingApprovals.length,
    };
  }, [workers, openPrs, pendingApprovals]);

  const pipelineTotal =
    pipeline.queued +
    pipeline.in_progress +
    pipeline.in_review +
    pipeline.done +
    pipeline.failed;

  const pipelineSegments = [
    { key: 'queued', count: pipeline.queued, color: 'bg-md-outline' },
    {
      key: 'inProgress',
      count: pipeline.in_progress,
      color: 'bg-brand',
    },
    { key: 'inReview', count: pipeline.in_review, color: 'bg-warning' },
    { key: 'done', count: pipeline.done, color: 'bg-success' },
    { key: 'failed', count: pipeline.failed, color: 'bg-error' },
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
            {t('dashboard.live')}
          </span>
        )}
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
            />
            <StatCard
              label={t('dashboard.inProgress')}
              value={pipeline.in_progress}
            />
            <StatCard label={t('dashboard.queued')} value={pipeline.queued} />
            <StatCard
              label={t('dashboard.openPrs')}
              value={openPrs.length}
              tone={stats.conflicting > 0 ? 'error' : undefined}
            />
            <StatCard
              label={t('dashboard.approvals')}
              value={stats.approvals}
              tone="warning"
            />
            <StatCard
              label={t('dashboard.failed')}
              value={pipeline.failed}
              tone="error"
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
                  const taskTitle =
                    activeTaskByWorkerId.get(worker.id) || ws?.taskTitle;
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
                              'bg-secondary text-normal'
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
                                  ? `${t('dashboard.running')} · ${formatRelativeTime(startedAt)}`
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
                      <p
                        className={cn(
                          'truncate text-sm',
                          taskTitle ? 'text-normal' : 'text-low'
                        )}
                      >
                        {taskTitle ?? t('dashboard.noActiveTask')}
                      </p>
                      <ContextBar ratio={contextRatio(ws)} />
                      <div className="flex items-center gap-4 border-t border-border/60 pt-2.5 text-xs text-low">
                        <span>
                          {t('dashboard.queue')}{' '}
                          <span className="font-semibold text-normal tabular-nums">
                            {worker.queued_count}
                          </span>
                        </span>
                        <span>
                          {t('dashboard.completedLabel')}{' '}
                          <span className="font-semibold text-normal tabular-nums">
                            {worker.completed_count}
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
            <SectionTitle>{t('dashboard.pipelineSection')}</SectionTitle>
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
              <SectionTitle>{t('dashboard.prsSection')}</SectionTitle>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
                {openPrs.length === 0 ? (
                  <p className="p-4 text-sm text-low">
                    {t('dashboard.prsEmpty')}
                  </p>
                ) : (
                  openPrs.map((ws) => (
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
                          <span className="tabular-nums">#{ws.prNumber}</span> ·{' '}
                          {ws.taskTitle || ws.name}
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
                      ) : (
                        <StatusPill
                          tone="muted"
                          label={t('dashboard.openPrs')}
                        />
                      )}
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <SectionTitle>{t('dashboard.attentionSection')}</SectionTitle>
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
                      className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left last:border-b-0 hover:bg-secondary"
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
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
