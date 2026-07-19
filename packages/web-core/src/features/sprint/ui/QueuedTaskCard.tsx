import { useTranslation } from 'react-i18next';
import { CaretUpIcon, CaretDownIcon, TrashIcon } from '@phosphor-icons/react';
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
    <article className="flex flex-col gap-half p-base bg-primary border border-border rounded-sm">
      <p
        className="text-sm text-normal font-medium truncate"
        title={task.title}
      >
        {task.title}
      </p>
      <div className="flex items-center justify-end gap-half">
        <Button
          variant="icon"
          size="icon"
          onClick={onMoveUp}
          disabled={!canMoveUp || isBusy}
          aria-label={t('sprint.queued.moveUp')}
          title={t('sprint.queued.moveUp')}
        >
          <CaretUpIcon className="size-icon-sm" weight="bold" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onMoveDown}
          disabled={!canMoveDown || isBusy}
          aria-label={t('sprint.queued.moveDown')}
          title={t('sprint.queued.moveDown')}
        >
          <CaretDownIcon className="size-icon-sm" weight="bold" />
        </Button>
        <Button
          variant="icon"
          size="icon"
          onClick={onRemove}
          disabled={isBusy}
          aria-label={t('sprint.queued.remove')}
          title={t('sprint.queued.remove')}
        >
          <TrashIcon className="size-icon-sm" weight="bold" />
        </Button>
      </div>
    </article>
  );
}
