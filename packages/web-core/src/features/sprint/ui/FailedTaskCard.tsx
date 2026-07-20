import { useTranslation } from 'react-i18next';
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react';
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
    <article className="group flex flex-col gap-2.5 p-3.5 bg-primary border border-destructive/30 rounded-xl shadow-soft transition-all duration-150 hover:border-destructive/50">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 shrink-0 text-destructive"
          aria-hidden
        >
          <AlertCircle className="h-3.5 w-3.5" />
        </span>
        <p
          className="text-sm text-high font-medium leading-snug line-clamp-2 flex-1"
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
          className="hover:text-brand"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onDiscard}
          disabled={isBusy}
          aria-label={t('sprint.failed.discard')}
          title={t('sprint.failed.discard')}
          className="hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </article>
  );
}
