import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
import type { WorkerTask } from '@/features/sprint/types';
import { useTranslation } from 'react-i18next';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';

interface InReviewTaskCardProps {
  task: WorkerTask;
}

function stateBadgeClass(state: string | null | undefined): string {
  const normalized = (state ?? '').toLowerCase();
  if (normalized === 'merged')
    return 'bg-merged/10 text-merged border border-merged/20';
  if (normalized === 'closed')
    return 'bg-md-surface-container text-md-on-surface-variant border border-md-outline-variant';
  if (normalized === 'open')
    return 'bg-success/10 text-success border border-success/20';
  return 'bg-md-surface-container text-md-on-surface border border-md-outline-variant';
}

export function InReviewTaskCard({ task }: InReviewTaskCardProps) {
  const { t } = useTranslation('tasks');
  const prUrl = task.pr_url ?? null;
  const prState = task.pr_state ?? null;
  const isConflicting = task.pr_mergeable === 'conflicting';
  const reviewResult = task.review_result ?? null;

  return (
    <article className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-outline-variant rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:-translate-y-px">
      <div className="flex items-start gap-2">
        {!reviewResult && (
          <span
            className="mt-1 h-2 w-2 rounded-full bg-md-primary animate-pulse shrink-0"
            aria-hidden
          />
        )}
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} className="mt-px" />
        )}
        <p
          className="text-body-sm font-sans text-md-on-surface font-medium leading-snug line-clamp-2"
          title={task.title}
        >
          {taskDisplayTitle(task)}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {reviewResult === 'approved' && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest bg-success/10 text-success border border-success/20">
            <MaterialIcon name="check_circle" size="xs" />
            {t('review.result.approved')}
          </span>
        )}
        {reviewResult === 'changes_requested' && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest bg-warning/10 text-warning border border-warning/20">
            <MaterialIcon name="edit_note" size="xs" />
            {t('review.result.changesRequested')}
          </span>
        )}
        {reviewResult === 'failed' && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest bg-destructive/10 text-destructive border border-destructive/20">
            <MaterialIcon name="error" size="xs" />
            {t('review.result.failed')}
          </span>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-body-sm text-md-primary hover:underline"
          >
            <MaterialIcon name="call_merge" size="xs" />
            <span className="truncate max-w-[10rem]">{prUrl}</span>
          </a>
        )}
        {prState && (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest',
              stateBadgeClass(prState)
            )}
          >
            {prState}
          </span>
        )}
        {isConflicting && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest bg-destructive/10 text-destructive border border-destructive/20">
            <MaterialIcon name="warning" size="xs" />
            {t('git.status.conflicts')}
          </span>
        )}
      </div>
    </article>
  );
}
