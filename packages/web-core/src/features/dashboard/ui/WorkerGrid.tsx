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
  contextRatio,
  formatDurationSince,
  formatTokensK,
} from '@/features/dashboard/model/dashboardMetrics';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { MeterBar, SectionTitle, StatusPill } from './parts/primitives';

function ContextBar({ ws }: { ws: SidebarWorkspace | undefined }) {
  const { t } = useTranslation('common');
  const ratio = contextRatio(ws);
  const usage = ws?.contextUsage;
  const value =
    ratio === null || !usage
      ? '—'
      : `${formatTokensK(usage.totalTokens)} / ${formatTokensK(usage.contextWindow)} · ${Math.round(ratio * 100)}%`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-low">
        <span>{t('dashboard.context')}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <MeterBar ratio={ratio} label={`${t('dashboard.context')} ${value}`} />
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
                  'flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3',
                  ws &&
                    'cursor-pointer hover:border-border-strong hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                )}
                // The whole card is the workspace link; there are no nested
                // controls inside it.
                role={ws ? 'button' : undefined}
                tabIndex={ws ? 0 : undefined}
                aria-label={
                  ws
                    ? t('dashboard.openWorkerWorkspace', { name: worker.name })
                    : undefined
                }
                onClick={
                  ws ? () => appNavigation.goToWorkspace(ws.id) : undefined
                }
                onKeyDown={
                  ws
                    ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        appNavigation.goToWorkspace(ws.id);
                      }
                    : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-high">
                    {worker.name}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
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
                <div className="flex items-center gap-4 border-t border-border pt-2 text-xs text-low">
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
                  <span className="ml-auto truncate font-mono text-code">
                    {ws?.branch ?? '—'}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
