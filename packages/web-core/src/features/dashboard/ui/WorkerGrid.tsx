import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { IssueBadge, taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import {
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '@/features/workers/model/chipColors';
import {
  CONTEXT_CRIT_RATIO,
  CONTEXT_WARN_RATIO,
  contextRatio,
  formatDurationSince,
  formatTokensK,
} from '@/features/dashboard/model/dashboardMetrics';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SectionTitle, StatusPill } from './parts/primitives';

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

export function WorkerGrid({
  workers,
  workspaceById,
  activeTaskByWorkerId,
  doneTodayByWorker,
}: Pick<
  DashboardData,
  'workers' | 'workspaceById' | 'activeTaskByWorkerId' | 'doneTodayByWorker'
>) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  return (
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
                  ws && 'cursor-pointer transition-shadow hover:shadow-card'
                )}
                onClick={
                  ws ? () => appNavigation.goToWorkspace(ws.id) : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-high">
                    {worker.name}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      ROLE_CHIP_CLASS[worker.role ?? 'developer'] ??
                        ROLE_CHIP_FALLBACK
                    )}
                  >
                    {t(`workers.roles.${worker.role ?? 'developer'}`)}
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
                      <StatusPill tone="muted" label={t('dashboard.idle')} />
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
  );
}
