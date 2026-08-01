import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';
import { SkillChips } from './SkillChips';

interface FailedTaskCardProps {
  task: WorkerTask;
  isBusy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  onViewProcesses?: () => void;
}

export function FailedTaskCard({
  task,
  isBusy,
  onRetry,
  onDiscard,
  onViewProcesses,
}: FailedTaskCardProps) {
  const { t } = useTranslation('common');
  const failureReason = task.failure_reason?.trim();
  const prUrl = task.pr_url ?? null;

  return (
    <article className="flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-error/30 rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-md-error/50">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="shrink-0 text-md-error" aria-hidden>
          <MaterialIcon name="error" size="xs" />
        </span>
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} />
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-body-sm text-md-primary hover:underline"
            title={prUrl}
          >
            <MaterialIcon name="call_merge" size="xs" />
            <span>{t('sprint.failed.viewPr')}</span>
          </a>
        )}
      </div>
      <p
        className="text-body-sm font-sans text-md-on-surface font-medium leading-snug line-clamp-2"
        title={task.title}
      >
        {taskDisplayTitle(task)}
      </p>
      {failureReason && (
        <p
          className="text-body-sm text-md-error line-clamp-3"
          title={failureReason}
        >
          {failureReason}
        </p>
      )}
      <SkillChips skills={task.skills ?? []} />
      <div className="flex items-center justify-end gap-1.5">
        {onViewProcesses && task.workspace_id && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onViewProcesses}
            disabled={isBusy}
            aria-label={t('sprint.failed.viewProcesses')}
            title={t('sprint.failed.viewProcesses')}
            className="text-md-on-surface-variant hover:text-md-primary hover:bg-md-primary/10"
          >
            <MaterialIcon name="visibility" size="xs" />
            {t('sprint.failed.viewProcesses')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={onRetry}
          disabled={isBusy}
          aria-label={t('sprint.failed.retry')}
          title={t('sprint.failed.retry')}
          className="text-md-on-surface-variant hover:text-md-primary hover:bg-md-primary/10"
        >
          <MaterialIcon name="refresh" size="xs" />
          {t('sprint.failed.retry')}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={onDiscard}
          disabled={isBusy}
          aria-label={t('sprint.failed.discard')}
          title={t('sprint.failed.discard')}
          className="text-md-on-surface-variant hover:text-md-error hover:bg-md-error/10"
        >
          <MaterialIcon name="delete" size="xs" />
          {t('sprint.failed.discard')}
        </Button>
      </div>
    </article>
  );
}
