import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CaretRightIcon,
  DotsThreeVerticalIcon,
  PlayIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import type { WorkerResponse } from 'shared/types';
import { Badge } from '@vibe/ui/components/Badge';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { WorkerTaskList } from './WorkerTaskList';

function WorkerAvatar({
  emoji,
  isWorking,
}: {
  emoji: string;
  isWorking: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary text-xl leading-none select-none color-emoji">
        {emoji}
      </div>
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-primary ${
          isWorking ? 'bg-success' : 'bg-low/50'
        }`}
        aria-hidden
      />
    </div>
  );
}

interface WorkerCardProps {
  worker: WorkerResponse;
  isStarting: boolean;
  onStartNext: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function WorkerCard({
  worker,
  isStarting,
  onStartNext,
  onEdit,
  onDelete,
}: WorkerCardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const [isExpanded, setIsExpanded] = useState(false);

  const isWorking = worker.active_workspace_id !== null;

  const handleOpenWorkspace = () => {
    if (worker.active_workspace_id) {
      appNavigation.goToWorkspace(worker.active_workspace_id);
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-border bg-secondary p-base gap-base transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-base">
        <WorkerAvatar emoji={worker.emoji} isWorking={isWorking} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-high truncate">
              {worker.name}
            </h3>
            <Badge
              variant={isWorking ? 'success' : 'neutral'}
              className="shrink-0"
            >
              {isWorking
                ? t('workers.card.statusWorking')
                : t('workers.card.statusIdle')}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-low">
            {isWorking && worker.active_workspace_id ? (
              <button
                type="button"
                onClick={handleOpenWorkspace}
                className="underline underline-offset-2 hover:text-normal cursor-pointer"
              >
                {t('workers.card.currentTaskLink')}
              </button>
            ) : (
              <span>{t('workers.card.noCurrentTask')}</span>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="icon"
              size="icon"
              aria-label={t('workers.card.menuLabel')}
            >
              <DotsThreeVerticalIcon className="size-icon-base" weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              {t('workers.card.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              {t('workers.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-3 text-xs text-low">
        <span>
          {t('workers.card.queuedCount', { count: worker.queued_count })}
        </span>
        <span aria-hidden>·</span>
        <span>
          {t('workers.card.completedCount', {
            count: worker.completed_count,
          })}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={onStartNext}
          disabled={isStarting || isWorking || worker.queued_count === 0}
        >
          {isStarting ? (
            <SpinnerIcon className="mr-1 size-icon-sm animate-spin" />
          ) : (
            <PlayIcon className="mr-1 size-icon-sm" weight="bold" />
          )}
          {t('workers.card.startNext')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? (
            <CaretDownIcon className="mr-1 size-icon-sm" weight="bold" />
          ) : (
            <CaretRightIcon className="mr-1 size-icon-sm" weight="bold" />
          )}
          {isExpanded
            ? t('workers.card.collapseQueue')
            : t('workers.card.expandQueue')}
        </Button>
      </div>

      {isExpanded && (
        <div className="border-t border-border pt-base">
          <WorkerTaskList
            workerId={worker.id}
            activeWorkspaceId={worker.active_workspace_id}
          />
        </div>
      )}
    </div>
  );
}
