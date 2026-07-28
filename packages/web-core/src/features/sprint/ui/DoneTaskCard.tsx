import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';
import { SkillChips } from './SkillChips';

interface DoneTaskCardProps {
  task: WorkerTask;
  isBusy: boolean;
  onRemove: () => void;
}

export function DoneTaskCard({ task, isBusy, onRemove }: DoneTaskCardProps) {
  const { t } = useTranslation('common');
  const [isConfirming, setIsConfirming] = useState(false);

  const handleRemoveClick = () => {
    setIsConfirming(true);
  };

  const handleConfirm = () => {
    setIsConfirming(false);
    onRemove();
  };

  const handleCancelConfirm = () => {
    setIsConfirming(false);
  };

  return (
    <article className="group flex flex-col gap-2 p-3.5 bg-md-surface-container-lowest/60 border border-md-outline-variant/50 rounded-lg">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success shrink-0"
          aria-hidden
        >
          <MaterialIcon name="check" size="xs" />
        </span>
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} className="mt-px" />
        )}
        <p
          className="text-body-sm font-sans text-md-on-surface-variant font-medium leading-snug line-clamp-2 flex-1"
          title={task.title}
        >
          {taskDisplayTitle(task)}
        </p>
        {!isConfirming && (
          <Button
            variant="icon"
            size="icon"
            onClick={handleRemoveClick}
            disabled={isBusy}
            aria-label={t('sprint.done.remove')}
            title={t('sprint.done.remove')}
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-md-error"
          >
            <MaterialIcon name="delete" size="sm" />
          </Button>
        )}
      </div>
      <SkillChips skills={task.skills ?? []} />
      {isConfirming && (
        <div className="flex flex-col gap-2 rounded-md border border-md-error/30 bg-md-error/5 px-3 py-2">
          <p className="text-body-sm text-md-on-surface">
            {t('sprint.done.removeConfirmMessage')}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCancelConfirm}
              disabled={isBusy}
            >
              {t('buttons.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={handleConfirm}
              disabled={isBusy}
            >
              {isBusy ? (
                <MaterialIcon
                  name="progress_activity"
                  size="xs"
                  className="animate-spin"
                />
              ) : (
                <MaterialIcon name="delete" size="xs" />
              )}
              {t('sprint.done.removeConfirm')}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
