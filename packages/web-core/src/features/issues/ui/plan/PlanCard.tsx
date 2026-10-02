import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import {
  PM_DECISION_LABEL,
  type PlanCardState,
} from '@/features/issues/lib/milestonePlan';
import { isExecutionLabel } from '@/features/issues/lib/executionLabels';

/**
 * One issue inside a wave column of the Plan view
 * (design/mockups/fluke-v2/issues-plan.html, `.card`).
 */

const HOT_TAGS = new Set(['P0', 'P1', 'BUG']);

const CARD_STATE_CLASS: Record<PlanCardState | 'manual', string> = {
  ready: 'border-success',
  gate: 'border-dashed border-warning',
  blocked: 'opacity-50',
  queued: 'border-dashed border-md-on-surface-variant',
  running: 'border-md-primary shadow-[0_0_0_1px_hsl(var(--md-primary)/0.3)]',
  review: 'border-violet-600 dark:border-violet-400',
  done: 'opacity-65',
  manual: '',
};

const STATE_TEXT_CLASS: Partial<Record<PlanCardState, string>> = {
  ready: 'text-success',
  gate: 'text-warning',
  running: 'text-md-primary',
  review: 'text-violet-600 dark:text-violet-400',
  done: 'text-success',
};

export interface PlanCardProps {
  issue: RepoIssue;
  /** `manual` for loose issues (no milestone or no wave) without a task. */
  state: PlanCardState | 'manual';
  /** Current wave of the band; used by the "waits for wave n" label. */
  currentWave: number | null;
  workerName?: string;
  selected?: boolean;
  onSelect?: (issue: RepoIssue) => void;
  onDecide?: (issue: RepoIssue) => void;
}

function Spinner() {
  return (
    <i
      aria-hidden
      className="inline-block size-[9px] animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

export function PlanCard({
  issue,
  state,
  currentWave,
  workerName,
  selected,
  onSelect,
  onDecide,
}: PlanCardProps) {
  const { t } = useTranslation('common');
  const tags = issue.labels
    .map((l) => l.name)
    .filter((name) => !isExecutionLabel(name) && name !== PM_DECISION_LABEL)
    .map((name) => name.toUpperCase());

  const label =
    state === 'manual'
      ? t('issues.plan.card.manual')
      : state === 'blocked'
        ? t('issues.plan.card.blocked', { n: currentWave ?? 0 })
        : t(`issues.plan.card.${state}`);

  const busy = state === 'running' || state === 'review';

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={t('issues.plan.card.open', { n: issue.number })}
      data-n={issue.number}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        onSelect?.(issue);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(issue);
        }
      }}
      className={cn(
        'relative z-[1] grid cursor-pointer gap-1.5 overflow-hidden rounded-md border border-md-outline-variant bg-md-surface-container-high px-3 py-2.5 text-left transition-[border-color,opacity] duration-200',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary',
        'group/card hover:border-md-on-surface-variant',
        CARD_STATE_CLASS[state],
        selected && 'ring-1 ring-md-on-surface'
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-2 right-2.5 text-[11px] text-normal opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-reduce:transition-none"
      >
        {t('issues.plan.card.openHint')}
      </span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-normal">
          #{issue.number}
        </span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-[5px] whitespace-nowrap text-[11px] text-normal',
            state !== 'manual' && STATE_TEXT_CLASS[state]
          )}
        >
          {busy && <Spinner />}
          {label}
        </span>
      </div>
      <div
        className={cn(
          'text-[13px] leading-[1.35] text-high',
          state === 'done' && 'line-through decoration-md-on-surface-variant'
        )}
      >
        {issue.title}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className={cn(
                'rounded border px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.04em]',
                HOT_TAGS.has(tag)
                  ? 'border-md-error/40 text-md-error'
                  : 'border-md-outline-variant text-normal'
              )}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {busy && workerName && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-normal">
          <span className="grid size-4 place-items-center rounded-full bg-md-primary font-sans text-[9px] font-semibold text-md-on-primary">
            {workerName[0]?.toUpperCase()}
          </span>
          {state === 'review'
            ? t('issues.plan.card.prReview', { name: workerName })
            : t('issues.plan.card.workerBranch', { name: workerName })}
        </div>
      )}
      {state === 'gate' && onDecide && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onDecide(issue)}
            className="inline-flex items-center rounded-md border border-md-outline-variant bg-md-surface-container px-2.5 py-1 text-xs text-high hover:border-md-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary"
          >
            {t('issues.plan.card.decideNow')}
          </button>
        </div>
      )}
    </div>
  );
}
