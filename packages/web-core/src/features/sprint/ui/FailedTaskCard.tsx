import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import type { WorkerTask } from '@/features/sprint/types';

interface FailedTaskCardProps {
  task: WorkerTask;
  isBusy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}

export function FailedTaskCard({
  task,
  isBusy,
  onRetry,
  onDiscard,
}: FailedTaskCardProps) {
  const { t } = useTranslation('common');

  return (
    <article className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-error/30 rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-md-error/50">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-md-error" aria-hidden>
          <MaterialIcon name="error" size="xs" />
        </span>
        <p
          className="text-body-sm font-sans text-md-on-surface font-medium leading-snug line-clamp-2 flex-1"
          title={task.title}
        >
          {task.title}
        </p>
      </div>
      <div className="flex items-center justify-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
        <Button
          variant="icon"
          size="icon"
          onClick={onRetry}
          disabled={isBusy}
          aria-label={t('sprint.failed.retry')}
          title={t('sprint.failed.retry')}
          className="hover:text-md-primary"
        >
          <MaterialIcon name="refresh" size="sm" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onDiscard}
          disabled={isBusy}
          aria-label={t('sprint.failed.discard')}
          title={t('sprint.failed.discard')}
          className="hover:text-md-error"
        >
          <MaterialIcon name="delete" size="sm" />
        </Button>
      </div>
    </article>
  );
}
