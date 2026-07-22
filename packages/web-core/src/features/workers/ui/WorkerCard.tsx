import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Play,
  SquareKanban,
} from 'lucide-react';
import type { WorkerResponse } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { WorkerTask } from '@/features/sprint/types';
import { WorkerTaskList } from './WorkerTaskList';

const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-brand/10 text-brand-on-surface',
  reviewer: 'bg-warning/10 text-warning',
};

interface WorkerCardProps {
  worker: WorkerResponse;
  activeTask?: WorkerTask;
  activeBranch?: string;
  isStarting: boolean;
  onStartNext: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function WorkerCard({
  worker,
  activeTask,
  activeBranch,
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
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Header: status dot + name + role chip + actions */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            isWorking ? 'animate-pulse bg-brand-on-surface' : 'bg-success'
          )}
          aria-hidden
        />
        <h3 className="truncate font-sans text-title text-high">
          {worker.name}
        </h3>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-px text-xs font-medium',
            ROLE_CHIP_CLASS[worker.role ?? 'developer'] ??
              'bg-secondary text-normal'
          )}
        >
          {t(`workers.roles.${worker.role ?? 'developer'}`)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="icon"
              size="icon"
              aria-label={t('workers.card.menuLabel')}
              title={t('workers.card.menuLabel')}
              className="ml-auto"
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              {t('workers.card.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-error focus:text-error"
            >
              {t('workers.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Body rows: task · branch · queue */}
      <div className="flex flex-1 flex-col gap-2 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {isWorking ? (
            <SquareKanban
              className="h-4 w-4 shrink-0 text-normal"
              strokeWidth={1.75}
              aria-hidden
            />
          ) : (
            <Check
              className="h-4 w-4 shrink-0 text-normal"
              strokeWidth={1.75}
              aria-hidden
            />
          )}
          {isWorking ? (
            activeTask ? (
              <span
                className="truncate text-sm text-high"
                title={activeTask.title}
              >
                {activeTask.title}
              </span>
            ) : (
              <button
                type="button"
                onClick={handleOpenWorkspace}
                className="truncate text-sm text-brand-on-surface hover:underline"
              >
                {t('workers.card.currentTaskLink')}
              </button>
            )
          ) : (
            <span className="truncate text-sm text-normal">
              {t('workers.card.noCurrentTask')}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <GitBranch
            className="h-4 w-4 shrink-0 text-normal"
            strokeWidth={1.75}
            aria-hidden
          />
          {activeBranch ? (
            <span
              className="truncate font-mono text-code text-normal"
              title={activeBranch}
            >
              {activeBranch}
            </span>
          ) : (
            <span className="font-mono text-code text-low">–</span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <ListTodo
            className="h-4 w-4 shrink-0 text-normal"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="truncate text-sm text-normal tabular-nums">
            {worker.queued_count} {t('workers.card.queuedLabel')} ·{' '}
            {worker.completed_count} {t('workers.card.completedLabel')}
          </span>
        </div>
      </div>

      {/* Footer on panel bg */}
      <div className="flex items-center gap-2 border-t border-border bg-md-surface-container-lowest px-3 py-2">
        {isWorking ? (
          <Button variant="secondary" onClick={handleOpenWorkspace}>
            {t('issues.taskLinked.openWorkspace')}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={onStartNext}
            disabled={isStarting || worker.queued_count === 0}
          >
            {isStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            {t('workers.card.startNext')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => setIsExpanded((v) => !v)}
          className="ml-auto"
        >
          {isExpanded
            ? t('workers.card.collapseQueue')
            : t('workers.card.expandQueue')}
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </Button>
      </div>

      {isExpanded && (
        <div className="border-t border-border bg-md-surface-container-lowest p-3">
          <WorkerTaskList
            workerId={worker.id}
            activeWorkspaceId={worker.active_workspace_id}
          />
        </div>
      )}
    </div>
  );
}
