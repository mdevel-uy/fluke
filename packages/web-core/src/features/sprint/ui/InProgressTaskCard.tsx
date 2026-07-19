import { useTranslation } from 'react-i18next';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { WorkerTask } from '@/features/sprint/types';

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
    <article className="flex flex-col gap-half p-base bg-primary border border-border rounded-sm">
      <p
        className="text-sm text-normal font-medium truncate"
        title={task.title}
      >
        {task.title}
      </p>
      {task.workspace_id && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="xs"
            onClick={handleOpen}
            title={t('sprint.inProgress.openWorkspace')}
          >
            <ArrowSquareOutIcon className="mr-1 size-icon-sm" weight="bold" />
            {t('sprint.inProgress.openWorkspace')}
          </Button>
        </div>
      )}
    </article>
  );
}
