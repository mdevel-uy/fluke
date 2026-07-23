import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';

interface InProgressTaskCardProps {
  task: WorkerTask;
}

export function InProgressTaskCard({ task }: InProgressTaskCardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  const handleOpen = () => {
    if (task.workspace_id) {
      appNavigation.goToWorkspace(task.workspace_id);
    }
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
      {task.workspace_id && (
        <div className="flex justify-end">
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
        </div>
      )}
    </article>
  );
}
