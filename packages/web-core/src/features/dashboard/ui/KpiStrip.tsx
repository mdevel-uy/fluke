import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SubDot } from './parts/primitives';

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

export function KpiStrip({
  stats,
  pipeline,
  reposInProgress,
  nextQueuedTask,
  openPrs,
  oldestApprovalWait,
  doneToday,
  failedToday,
}: Pick<
  DashboardData,
  | 'stats'
  | 'pipeline'
  | 'reposInProgress'
  | 'nextQueuedTask'
  | 'openPrs'
  | 'oldestApprovalWait'
  | 'doneToday'
  | 'failedToday'
>) {
  const { t } = useTranslation('common');
  return (
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
  );
}
