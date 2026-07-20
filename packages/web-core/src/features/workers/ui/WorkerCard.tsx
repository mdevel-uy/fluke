import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Play,
  Loader2,
} from 'lucide-react';
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
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-3xl leading-none select-none color-emoji"
        aria-hidden
      >
        {emoji}
      </div>
      <span
        className={
          'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-primary ' +
          (isWorking ? 'bg-success animate-pulse' : 'bg-low/50')
        }
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
    <div className="group flex flex-col rounded-2xl border border-border/60 bg-primary shadow-card transition-all duration-200 hover:shadow-card-hover hover:-translate-y-0.5">
      {/* Header — avatar + name + status pill + menu */}
      <div className="flex items-start gap-4 p-5">
        <WorkerAvatar emoji={worker.emoji} isWorking={isWorking} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-semibold text-high truncate leading-tight">
              {worker.name}
            </h3>
            <Badge
              variant={isWorking ? 'success' : 'neutral'}
              className="gap-1.5"
            >
              <span
                className={
                  'h-1.5 w-1.5 rounded-full ' +
                  (isWorking ? 'bg-success animate-pulse' : 'bg-low')
                }
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
          <div className="mt-1 text-sm text-low leading-snug">
            {isWorking && worker.active_workspace_id ? (
              <button
                type="button"
                onClick={handleOpenWorkspace}
                className="text-brand hover:text-brand-hover hover:underline cursor-pointer"
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
              className="opacity-70 group-hover:opacity-100 transition-opacity"
            >
              <MoreVertical className="h-4 w-4" />
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

      {/* Metadata row — counts */}
      <div className="flex items-center gap-4 px-5 pb-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold text-high tabular-nums">
            {worker.queued_count}
          </span>
          <span className="text-xs text-low uppercase tracking-wide">
            {t('workers.card.queuedLabel')}
          </span>
        </div>
        <span className="h-4 w-px bg-border/70" aria-hidden />
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold text-high tabular-nums">
            {worker.completed_count}
          </span>
          <span className="text-xs text-low uppercase tracking-wide">
            {t('workers.card.completedLabel')}
          </span>
        </div>
      </div>

      {/* Actions footer */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-secondary/40 px-4 py-3 rounded-b-2xl">
        <Button
          variant="primary"
          size="sm"
          onClick={onStartNext}
          disabled={isStarting || isWorking || worker.queued_count === 0}
        >
          {isStarting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {t('workers.card.startNext')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded((v) => !v)}
          className="ml-auto"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          {isExpanded
            ? t('workers.card.collapseQueue')
            : t('workers.card.expandQueue')}
        </Button>
      </div>

      {isExpanded && (
        <div className="border-t border-border/60 p-4">
          <WorkerTaskList
            workerId={worker.id}
            activeWorkspaceId={worker.active_workspace_id}
          />
        </div>
      )}
    </div>
  );
}
