import { useTranslation } from 'react-i18next';
import type { MilestoneRun } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type { MilestoneBand as Band } from '@/features/issues/lib/milestonePlan';
import type { DecisionContext } from './DecisionDrawer';
import { BandStatus, decisionContext } from './MilestoneBand';
import { SEGMENT } from './CollapsedSummary';
import {
  DragHandle,
  MilestoneQuickActions,
  MilestoneTagChips,
  StarButton,
  type MilestoneActions,
} from './MilestoneControls';

/**
 * One milestone as a single 40px row of the compact Plan view
 * (design/mockups/fluke-v2/milestone-actions-compact.dc.html): handle,
 * star, play, name with tags and status, wave segments, "Decide #n" and the
 * progress, which hover swaps for the quick actions. A click on the name
 * opens it; the open milestone is drawn as its full band by the caller.
 */

export interface CompactMilestoneRowProps {
  band: Band;
  run?: MilestoneRun;
  actions: MilestoneActions;
  onOpen: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  busy?: boolean;
  onDecide?: (issue: RepoIssue, context: DecisionContext) => void;
}

export function CompactMilestoneRow({
  band,
  run,
  actions,
  onOpen,
  onPlay,
  onPause,
  busy,
  onDecide,
}: CompactMilestoneRowProps) {
  const { t } = useTranslation('common');
  const runActive = run?.status === 'running' || run?.status === 'waiting';
  const gate =
    band.status.kind === 'decision'
      ? band.waves
          .flatMap((w) => w.cards)
          .find(
            (c) =>
              band.status.kind === 'decision' &&
              c.issue.number === band.status.issueNumber
          )?.issue
      : undefined;
  const percent = band.total ? (100 * band.done) / band.total : 0;
  const { reorder } = actions;

  return (
    <div
      onDragOver={reorder.onDragOver}
      onDrop={reorder.onDrop}
      className={cn(
        'group grid h-10 grid-cols-[16px_28px_24px_minmax(0,1fr)_auto_120px] items-center gap-2 border-t border-md-outline-variant/60 pl-1.5 pr-3 first:border-t-0 hover:bg-md-surface-container',
        reorder.dragging && 'opacity-40',
        reorder.over && 'shadow-[inset_0_3px_0_0_hsl(var(--md-primary))]'
      )}
    >
      <DragHandle
        reorder={reorder}
        className="text-transparent group-hover:text-low"
      />
      <StarButton starred={actions.starred} onToggle={actions.onToggleStar} />
      <button
        type="button"
        disabled={busy || run?.status === 'done'}
        onClick={runActive ? onPause : onPlay}
        aria-label={t(runActive ? 'issues.plan.pause' : 'issues.plan.play')}
        className={cn(
          'grid size-6 place-items-center rounded-full border border-md-primary text-md-primary hover:bg-md-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary disabled:opacity-60',
          runActive && 'bg-md-primary text-md-on-primary'
        )}
      >
        <svg viewBox="0 0 16 16" className="size-2.5 fill-current" aria-hidden>
          {runActive ? (
            <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
          ) : (
            <path d="M4 2.5v11l9-5.5z" />
          )}
        </svg>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-10 min-w-0 items-center gap-1.5 overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-md-primary"
      >
        <span
          className={cn(
            'whitespace-nowrap text-[13px] text-normal',
            gate && 'font-semibold text-high'
          )}
        >
          {band.milestone}
        </span>
        <MilestoneTagChips tags={actions.tags} max={2} />
        <span className="min-w-0 truncate text-xs text-low">
          — <BandStatus band={band} run={run} />
        </span>
      </button>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center gap-1">
          {band.waves.map((w) => (
            <span key={w.wave} className="inline-flex gap-0.5">
              {w.cards.map((c) => (
                <i
                  key={c.issue.id}
                  className={cn('h-1.5 w-2.5 rounded-[2px]', SEGMENT[c.state])}
                />
              ))}
            </span>
          ))}
        </span>
        {gate && onDecide && (
          <button
            type="button"
            onClick={() => onDecide(gate, decisionContext(band, gate))}
            className="h-5 whitespace-nowrap rounded-full bg-warning px-2 text-[11px] font-semibold text-warning-foreground hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
          >
            {t('issues.plan.summary.decide', { n: gate.number })}
          </button>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 group-focus-within:hidden group-hover:hidden">
        <div className="h-1 w-14 overflow-hidden rounded-sm bg-md-outline-variant">
          <i
            className="block h-full bg-success"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="w-8 text-right font-mono text-[11px] tabular-nums text-normal">
          {band.done}/{band.total}
        </span>
      </div>
      <div className="hidden items-center justify-end gap-0.5 group-focus-within:flex group-hover:flex">
        <MilestoneQuickActions actions={actions} />
      </div>
    </div>
  );
}
