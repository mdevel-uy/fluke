import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronUp,
  File,
  GitBranch,
  Hand,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Play,
  SquareKanban,
} from 'lucide-react';
import type { WorkerResponse } from 'shared/types';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
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
import { IssueBadge, taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import {
  modelChipClass,
  ROLE_CHIP_CLASS,
  ROLE_CHIP_FALLBACK,
} from '../model/chipColors';
import { WorkerTaskList } from './WorkerTaskList';

/** Compact duration since a timestamp: 12m, 3h, 2d */
function formatDurationSince(dateString: string): string {
  const diffMins = Math.max(
    0,
    Math.floor((Date.now() - new Date(dateString).getTime()) / 60_000)
  );
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

interface WorkerCardProps {
  worker: WorkerResponse;
  queuedCount: number;
  activeTask?: WorkerTask;
  /** Sidebar summary of the worker's active workspace, if any */
  activeWorkspace?: SidebarWorkspace;
  needsAttention?: boolean;
  isStarting: boolean;
  isDuplicating?: boolean;
  onStartNext: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function WorkerCard({
  worker,
  queuedCount,
  activeTask,
  activeWorkspace,
  needsAttention = false,
  isStarting,
  isDuplicating = false,
  onStartNext,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkerCardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const [isExpanded, setIsExpanded] = useState(false);

  const isWorking = worker.active_workspace_id !== null;
  const activeBranch = activeWorkspace?.branch;
  const isWaitingApproval = activeWorkspace?.hasPendingApproval ?? false;

  const contextUsage = activeWorkspace?.contextUsage;
  const contextPct =
    isWorking && contextUsage && contextUsage.contextWindow > 0
      ? Math.min(
          100,
          (contextUsage.totalTokens / contextUsage.contextWindow) * 100
        )
      : null;

  const filesChanged = activeWorkspace?.filesChanged;
  const hasChanges =
    isWorking && filesChanged !== undefined && filesChanged > 0;

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
            needsAttention
              ? 'bg-error'
              : isWaitingApproval
                ? 'bg-warning'
                : isWorking
                  ? 'animate-pulse bg-brand-on-surface'
                  : 'bg-success'
          )}
          aria-hidden
        />
        <h3 className="truncate font-sans text-title text-high">
          {worker.name}
        </h3>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-px text-xs font-medium',
            ROLE_CHIP_CLASS[worker.role ?? 'developer'] ?? ROLE_CHIP_FALLBACK
          )}
        >
          {t(`workers.roles.${worker.role ?? 'developer'}`)}
        </span>
        {worker.model && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-px font-mono text-xs',
              modelChipClass(worker.model)
            )}
          >
            {worker.model}
          </span>
        )}
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
            <DropdownMenuItem onClick={onDuplicate} disabled={isDuplicating}>
              {t('workers.card.duplicate')}
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
              <>
                {activeTask.issue_number != null && (
                  <IssueBadge issueNumber={activeTask.issue_number} />
                )}
                <span
                  className="truncate text-sm text-high"
                  title={activeTask.title}
                >
                  {taskDisplayTitle(activeTask)}
                </span>
              </>
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

        {/* Context usage bar: % of the agent's context window in use */}
        {contextPct !== null && (
          <div className="flex w-full items-center gap-2">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  'h-full rounded-full',
                  contextPct >= 90
                    ? 'bg-error'
                    : contextPct >= 70
                      ? 'bg-warning'
                      : 'bg-success'
                )}
                style={{ width: `${contextPct}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-low">
              {t('workspaces.contextPct', { pct: Math.round(contextPct) })}
            </span>
          </div>
        )}

        {/* Attention row: approval chip / stalled notice + diff stats */}
        {(isWaitingApproval || needsAttention || hasChanges) && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            {needsAttention ? (
              <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-error">
                {t('workers.card.stalledShort')}
                {activeWorkspace?.latestProcessCompletedAt && (
                  <span className="tabular-nums">
                    ·{' '}
                    {formatDurationSince(
                      activeWorkspace.latestProcessCompletedAt
                    )}
                  </span>
                )}
              </span>
            ) : isWaitingApproval ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded bg-warning/10 px-2 py-0.5 text-sm font-medium text-warning">
                <Hand className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                {t('workspaces.activityWaitingApproval')}
              </span>
            ) : (
              <span />
            )}
            {hasChanges && (
              <span className="flex shrink-0 items-center gap-1 text-sm text-normal tabular-nums">
                <File className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                <span>{filesChanged}</span>
                {activeWorkspace?.linesAdded !== undefined && (
                  <span className="text-success">
                    +{activeWorkspace.linesAdded}
                  </span>
                )}
                {activeWorkspace?.linesRemoved !== undefined && (
                  <span className="text-error">
                    -{activeWorkspace.linesRemoved}
                  </span>
                )}
              </span>
            )}
          </div>
        )}

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
            {queuedCount} {t('workers.card.queuedLabel')} ·{' '}
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
            disabled={isStarting || queuedCount === 0}
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
