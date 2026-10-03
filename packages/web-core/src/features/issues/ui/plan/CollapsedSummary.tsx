import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { instanceLabel } from '@/features/workers/model/instance';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import type {
  MilestoneBand,
  PlanCardState,
} from '@/features/issues/lib/milestonePlan';

/**
 * What a collapsed band shows under its header (#664, mockup `.sum`): a mini
 * map of waves with one segment per issue painted by state, the counts, the
 * workers on it right now and "Decidir #n" when a decision is pending.
 */

const SEGMENT: Record<PlanCardState, string> = {
  done: 'bg-success',
  running: 'bg-md-primary',
  review: 'bg-violet-600 dark:bg-violet-400',
  gate: 'border border-dashed border-warning',
  queued: 'border border-dashed border-md-on-surface-variant',
  ready: 'bg-success/60',
  blocked: 'bg-md-outline/50',
};

const COUNTS: { key: string; states: PlanCardState[]; dot: string }[] = [
  { key: 'done', states: ['done'], dot: 'bg-success' },
  { key: 'running', states: ['running'], dot: 'bg-md-primary' },
  {
    key: 'review',
    states: ['review'],
    dot: 'bg-violet-600 dark:bg-violet-400',
  },
  { key: 'queued', states: ['queued'], dot: 'bg-md-on-surface-variant' },
  { key: 'gate', states: ['gate'], dot: 'bg-warning' },
  { key: 'todo', states: ['ready', 'blocked'], dot: 'bg-md-outline' },
];

export function CollapsedSummary({
  band,
  taskByIssueNumber,
  workerNameById,
  onDecide,
}: {
  band: MilestoneBand;
  taskByIssueNumber: ReadonlyMap<number, WorkerTask>;
  workerNameById: ReadonlyMap<string, string>;
  onDecide?: (issue: RepoIssue) => void;
}) {
  const { t } = useTranslation('common');
  const cards = band.waves.flatMap((w) => w.cards);
  const running = band.status.kind === 'running';
  const pendingDecision = cards.find((c) => c.state === 'gate');

  const workers = cards
    .filter((c) => c.state === 'running' || c.state === 'review')
    .map((c) => {
      const task = taskByIssueNumber.get(c.issue.number);
      const profile = task ? workerNameById.get(task.worker_id) : undefined;
      return profile
        ? {
            name: instanceLabel(profile, task?.workspace_id),
            issue: c.issue.number,
          }
        : null;
    })
    .filter((w): w is { name: string; issue: number } => w !== null);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-md-outline-variant bg-md-surface-container-low py-2.5 pl-4 pr-4 text-xs text-normal sm:pl-[58px]">
      <div className="flex flex-wrap items-center gap-2.5">
        {band.waves.map((wave, i) => (
          <Fragment key={wave.wave}>
            {i > 0 && <span className="text-md-outline">→</span>}
            <span
              className={cn(
                'inline-flex items-center gap-1.5 font-mono text-[11px] font-medium tracking-[0.06em]',
                running && wave.wave === band.currentWave && 'text-md-primary'
              )}
            >
              W{wave.wave}
              <span className="inline-flex gap-[3px]">
                {wave.cards.map((c) => (
                  <i
                    key={c.issue.id}
                    title={`#${c.issue.number}`}
                    className={cn(
                      'h-[7px] w-[13px] rounded-[2px]',
                      SEGMENT[c.state]
                    )}
                  />
                ))}
              </span>
            </span>
          </Fragment>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5">
        {COUNTS.map(({ key, states, dot }) => {
          const n = cards.filter((c) => states.includes(c.state)).length;
          if (!n) return null;
          return (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 tabular-nums"
            >
              <i className={cn('size-[7px] rounded-full', dot)} />
              {t(`issues.plan.summary.${key}`, { count: n })}
            </span>
          );
        })}
      </div>

      {workers.length > 0 && (
        <span className="inline-flex items-center gap-1">
          {workers.map((w) => (
            <span
              key={w.issue}
              title={`${w.name} · #${w.issue}`}
              className="grid size-4 place-items-center rounded-full bg-md-primary text-[9px] font-semibold text-md-on-primary"
            >
              {w.name[0]?.toUpperCase()}
            </span>
          ))}
          <span className="ml-1">{t('issues.plan.summary.working')}</span>
        </span>
      )}

      {pendingDecision && onDecide && (
        <button
          type="button"
          onClick={() => onDecide(pendingDecision.issue)}
          className="ml-auto rounded-md border border-warning bg-warning px-2.5 py-1 text-xs font-semibold text-warning-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
        >
          {t('issues.plan.summary.decide', { n: pendingDecision.issue.number })}
        </button>
      )}
    </div>
  );
}
