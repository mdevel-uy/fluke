import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IssueBlocker } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { blockerAge, blockerPhaseKind } from '@/features/issues/lib/blocker';
import type { RepoIssue } from '@/features/issues/types';
import {
  PM_DECISION_LABEL,
  type PlanCardState,
} from '@/features/issues/lib/milestonePlan';
import { isExecutionLabel } from '@/features/issues/lib/executionLabels';
import type { WorkerTask } from '@/features/sprint/types';
import { DesignArtifactLinks } from '@/features/sprint/ui/DesignArtifactLinks';
import { workersKeys } from '@/features/workers';
import { workersApi } from '@/shared/lib/api';

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
  /* `\_` escapa el underscore: en un valor arbitrario Tailwind convierte
     `_` en espacio, y `var(-- success)` rompe la minificación CSS. */
  approved: 'border-success shadow-[0_0_0_2px_hsl(var(--\\_success)/0.35)]',
  stuck:
    'border-md-error shadow-[0_0_0_1px_hsl(var(--md-error)/0.35),0_6px_20px_-10px_hsl(var(--md-error))]',
  done: 'opacity-65',
  manual: '',
};

const STATE_TEXT_CLASS: Partial<Record<PlanCardState, string>> = {
  ready: 'text-success',
  gate: 'text-warning',
  running: 'text-md-primary',
  review: 'text-violet-600 dark:text-violet-400',
  approved: 'text-success',
  stuck: 'text-md-error',
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
  /** Why the issue needs a person (#694), when `state` is `stuck`. */
  blocker?: IssueBlocker;
  onUnstick?: (issue: RepoIssue) => void;
  /** The issue's worker task; a designer one in review gets the approval gate. */
  task?: WorkerTask;
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
  blocker,
  onUnstick,
  task,
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
  // Designers never open a PR: their exit from review is the user's approval.
  const designTask =
    state === 'review' && task?.deliverable_ref?.startsWith('design/')
      ? task
      : undefined;
  const phaseKind = blocker ? blockerPhaseKind(blocker) : null;
  const age = blocker ? blockerAge(blocker.since) : null;

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={t('issues.plan.card.open', { n: issue.number })}
      data-n={issue.number}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
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
      {(busy || state === 'approved') && workerName && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-normal">
          <span className="grid size-4 place-items-center rounded-full bg-md-primary font-sans text-[9px] font-semibold text-md-on-primary">
            {workerName[0]?.toUpperCase()}
          </span>
          {state === 'approved'
            ? t('issues.plan.card.prApproved', { name: workerName })
            : designTask
              ? `${workerName} · ${t('sprint.designReview.awaitingApproval')}`
              : state === 'review'
                ? t('issues.plan.card.prReview', { name: workerName })
                : t('issues.plan.card.workerBranch', { name: workerName })}
        </div>
      )}
      {designTask && <DesignApproval task={designTask} />}
      {state === 'stuck' && workerName && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-normal">
          <span className="grid size-4 place-items-center rounded-full bg-md-primary font-sans text-[9px] font-semibold text-md-on-primary">
            {workerName[0]?.toUpperCase()}
          </span>
          {t('issues.plan.card.waitingYou', { name: workerName })}
        </div>
      )}
      {state === 'stuck' && blocker && (
        <div className="rounded bg-md-error/10 px-2 py-1.5 text-xs leading-[1.4] text-high">
          {(phaseKind || age) && (
            <small className="mb-0.5 block text-[11px] text-normal">
              {[
                phaseKind && t(`issues.plan.phases.kind.${phaseKind}`),
                age && t('issues.plan.card.ago', { age }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </small>
          )}
          {blocker.message}
        </div>
      )}
      {state === 'stuck' && onUnstick && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onUnstick(issue)}
            className="inline-flex items-center rounded-md border border-md-error bg-md-error px-2.5 py-1 text-xs font-semibold text-md-on-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
          >
            {t('issues.plan.card.unstick')}
          </button>
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

/** Artifact links + approve (with confirmation) for a designer in review. */
function DesignApproval({ task }: { task: WorkerTask }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const approve = useMutation({
    mutationFn: () => workersApi.approveDesign(task.worker_id, task.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workersKeys.all }),
  });

  return (
    <div className="grid gap-1.5">
      <DesignArtifactLinks task={task} />
      {approve.error && (
        <p className="m-0 text-xs text-md-error">
          {t('sprint.toast.designApproveError', {
            message: approve.error.message,
          })}
        </p>
      )}
      {confirming && (
        <p className="m-0 text-xs text-high">
          {t('sprint.designReview.approveConfirmMessage')}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="inline-flex items-center rounded-md border border-md-outline-variant bg-md-surface-container px-2.5 py-1 text-xs text-high hover:border-md-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary"
          >
            {t('buttons.cancel')}
          </button>
        )}
        <button
          type="button"
          disabled={approve.isPending}
          onClick={() => (confirming ? approve.mutate() : setConfirming(true))}
          className="inline-flex items-center rounded-md border border-success bg-success px-2.5 py-1 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary disabled:opacity-60"
        >
          {confirming
            ? t('sprint.designReview.approveConfirm')
            : t('sprint.designReview.approve')}
        </button>
      </div>
    </div>
  );
}
