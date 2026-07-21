import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
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
    <article className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-outline-variant rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-md-primary/30 hover:-translate-y-px">
      <p
        className="text-body-sm font-sans text-md-on-surface font-medium leading-snug line-clamp-2"
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
          <MaterialIcon name="keyboard_arrow_up" size="sm" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onMoveDown}
          disabled={!canMoveDown || isBusy}
          aria-label={t('sprint.queued.moveDown')}
          title={t('sprint.queued.moveDown')}
        >
          <MaterialIcon name="keyboard_arrow_down" size="sm" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onRemove}
          disabled={isBusy}
          aria-label={t('sprint.queued.remove')}
          title={t('sprint.queued.remove')}
          className="hover:text-md-error"
        >
          <MaterialIcon name="delete" size="sm" />
        </Button>
      </div>
    </article>
  );
}
