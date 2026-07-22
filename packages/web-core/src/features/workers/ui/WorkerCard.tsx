import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { Badge } from '@vibe/ui/components/Badge';
import { Button } from '@vibe/ui/components/Button';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
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
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl bg-md-surface-container-low text-3xl leading-none select-none color-emoji"
        aria-hidden
      >
        {emoji}
      </div>
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-md-surface-container-lowest',
          isWorking ? 'bg-success' : 'bg-md-outline/50'
        )}
        aria-hidden
      />
    </div>
  );
}

type RoleBadgeVariant = 'neutral' | 'info' | 'warning';

function roleBadgeVariant(role: string): RoleBadgeVariant {
  switch (role) {
    case 'analyst':
      return 'info';
    case 'reviewer':
      return 'warning';
    default:
      return 'neutral';
  }
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
    <div className="group flex flex-col rounded-lg border border-md-outline-variant bg-card transition-colors duration-150 hover:border-md-outline">
      {/* Header */}
      <div className="flex items-start gap-4 p-5">
        <WorkerAvatar emoji={worker.emoji} isWorking={isWorking} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-title-sm font-sans font-semibold text-md-on-surface truncate leading-tight">
              {worker.name}
            </h3>
            <Badge
              variant={isWorking ? 'success' : 'neutral'}
              className="gap-1.5 text-label-caps font-geist font-semibold uppercase tracking-widest"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isWorking ? 'bg-success animate-pulse' : 'bg-md-outline/50'
                )}
                aria-hidden
              />
              {isWorking
                ? t('workers.card.statusWorking')
                : t('workers.card.statusIdle')}
            </Badge>
            <Badge variant={roleBadgeVariant(worker.role ?? 'developer')}>
              {t(`workers.roles.${worker.role ?? 'developer'}`)}
            </Badge>
          </div>
          <div className="mt-1 text-body-sm text-md-on-surface-variant leading-snug">
            {isWorking && worker.active_workspace_id ? (
              <button
                type="button"
                onClick={handleOpenWorkspace}
                className="text-md-primary hover:underline cursor-pointer"
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
              className="text-md-on-surface-variant hover:text-md-on-surface transition-colors"
            >
              <MaterialIcon name="more_vert" size="base" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              {t('workers.card.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-md-error focus:text-md-error"
            >
              {t('workers.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 px-5 pb-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-title-sm font-semibold text-md-on-surface tabular-nums">
            {worker.queued_count}
          </span>
          <span className="text-label-caps font-geist font-semibold uppercase tracking-widest text-md-on-surface-variant">
            {t('workers.card.queuedLabel')}
          </span>
        </div>
        <span className="h-4 w-px bg-md-outline-variant" aria-hidden />
        <div className="flex items-baseline gap-1.5">
          <span className="text-title-sm font-semibold text-md-on-surface tabular-nums">
            {worker.completed_count}
          </span>
          <span className="text-label-caps font-geist font-semibold uppercase tracking-widest text-md-on-surface-variant">
            {t('workers.card.completedLabel')}
          </span>
        </div>
      </div>

      {/* Actions footer */}
      <div className="flex items-center gap-2 border-t border-md-outline-variant bg-md-surface-container-low px-4 py-3 rounded-b-lg">
        <button
          type="button"
          onClick={onStartNext}
          disabled={isStarting || isWorking || worker.queued_count === 0}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
            'bg-md-primary text-md-on-primary text-body-sm font-semibold',
            'hover:opacity-90 active:scale-95 transition-all duration-200',
            'disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          <MaterialIcon
            name={isStarting ? 'progress_activity' : 'play_arrow'}
            size="sm"
            className={isStarting ? 'animate-spin' : ''}
          />
          {t('workers.card.startNext')}
        </button>
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          className="ml-auto flex items-center gap-1 px-2 py-1.5 rounded-lg text-body-sm text-md-on-surface-variant hover:bg-md-surface-container hover:text-md-on-surface active:scale-95 transition-all duration-200"
        >
          <MaterialIcon
            name={isExpanded ? 'expand_less' : 'expand_more'}
            size="sm"
          />
          {isExpanded
            ? t('workers.card.collapseQueue')
            : t('workers.card.expandQueue')}
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-md-outline-variant p-4">
          <WorkerTaskList
            workerId={worker.id}
            activeWorkspaceId={worker.active_workspace_id}
          />
        </div>
      )}
    </div>
  );
}
