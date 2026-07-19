import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import type { WorkerTask } from '@/features/sprint/types';

interface QueuedTaskCardProps {
  task: WorkerTask;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isBusy: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

export function QueuedTaskCard({
  task,
  canMoveUp,
  canMoveDown,
  isBusy,
  onMoveUp,
  onMoveDown,
  onRemove,
}: QueuedTaskCardProps) {
  const { t } = useTranslation('common');

  return (
    <article className="group flex flex-col gap-2.5 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card hover:border-border">
      <p
        className="text-sm text-high font-medium leading-snug line-clamp-2"
        title={task.title}
      >
        {task.title}
      </p>
      <div className="flex items-center justify-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
        <Button
          variant="icon"
          size="icon"
          onClick={onMoveUp}
          disabled={!canMoveUp || isBusy}
          aria-label={t('sprint.queued.moveUp')}
          title={t('sprint.queued.moveUp')}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onMoveDown}
          disabled={!canMoveDown || isBusy}
          aria-label={t('sprint.queued.moveDown')}
          title={t('sprint.queued.moveDown')}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onRemove}
          disabled={isBusy}
          aria-label={t('sprint.queued.remove')}
          title={t('sprint.queued.remove')}
          className="hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </article>
  );
}
