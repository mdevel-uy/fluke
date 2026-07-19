import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
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
    <article className="group relative flex flex-col gap-2.5 p-3.5 bg-primary border border-brand/30 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card">
      <div className="absolute left-0 top-3 bottom-3 w-0.5 bg-brand rounded-r-full" />
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-2 w-2 rounded-full bg-brand animate-pulse shrink-0"
          aria-hidden
        />
        <p
          className="text-sm text-high font-medium leading-snug line-clamp-2"
          title={task.title}
        >
          {task.title}
        </p>
      </div>
      {task.workspace_id && (
        <div className="flex justify-end">
          <Button
            variant="tonal"
            size="xs"
            onClick={handleOpen}
            title={t('sprint.inProgress.openWorkspace')}
          >
            <ExternalLink className="h-3 w-3" />
            {t('sprint.inProgress.openWorkspace')}
          </Button>
        </div>
      )}
    </article>
  );
}
