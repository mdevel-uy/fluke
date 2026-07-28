import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';
import { SkillChips } from './SkillChips';

interface InProgressTaskCardProps {
  task: WorkerTask;
  isBusy: boolean;
  onStop: () => void;
}

export function InProgressTaskCard({
  task,
  isBusy,
  onStop,
}: InProgressTaskCardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const [isConfirming, setIsConfirming] = useState(false);

  const handleOpen = () => {
    if (task.workspace_id) {
      appNavigation.goToWorkspace(task.workspace_id);
    }
  };

  const handleStopClick = () => {
    setIsConfirming(true);
  };

  const handleConfirm = () => {
    setIsConfirming(false);
    onStop();
  };

  const handleCancelConfirm = () => {
    setIsConfirming(false);
  };

  return (
    <article className="group relative flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-primary/30 rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover">
      <div className="absolute left-0 top-3 bottom-3 w-0.5 bg-md-primary rounded-r-full" />
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-2 w-2 rounded-full bg-md-primary animate-pulse shrink-0"
          aria-hidden
        />
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} className="mt-px" />
        )}
        <p
          className="text-body-sm font-sans text-md-on-surface font-semibold leading-snug line-clamp-2"
          title={task.title}
        >
          {taskDisplayTitle(task)}
        </p>
      </div>
      <SkillChips skills={task.skills ?? []} />
      {isConfirming ? (
        <div className="flex flex-col gap-2 rounded-md border border-md-error/30 bg-md-error/5 px-3 py-2">
          <p className="text-body-sm text-md-on-surface">
            {t('sprint.inProgress.stopConfirmMessage')}
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
                <MaterialIcon name="stop_circle" size="xs" />
              )}
              {t('sprint.inProgress.stopAndUnassign')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleStopClick}
            disabled={isBusy}
            title={t('sprint.inProgress.stop')}
            aria-label={t('sprint.inProgress.stop')}
            className="text-md-on-surface-variant hover:text-md-error hover:bg-md-error/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MaterialIcon name="stop_circle" size="xs" />
            {t('sprint.inProgress.stop')}
          </Button>
          {task.workspace_id && (
            <Button
              variant="tonal"
              size="xs"
              onClick={handleOpen}
              title={t('sprint.inProgress.openWorkspace')}
              className="active:scale-95 transition-all duration-200"
            >
              <MaterialIcon name="open_in_new" size="xs" />
              {t('sprint.inProgress.openWorkspace')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
