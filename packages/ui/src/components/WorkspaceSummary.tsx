import {
  PushPinIcon,
  HandIcon,
  TriangleIcon,
  PlayIcon,
  FileIcon,
  CircleIcon,
  ClockIcon,
  GitPullRequestIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { ContextUsageGauge } from './ContextUsageGauge';

const formatRelativeElapsed = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

export interface WorkspaceContextUsage {
  totalTokens: number;
  contextWindow: number;
}

export interface WorkspaceSummaryProps {
  name: string;
  workspaceId?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isActive?: boolean;
  isRunning?: boolean;
  isPinned?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  /** Context window usage of the agent session, if known */
  contextUsage?: WorkspaceContextUsage | null;
  onClick?: () => void;
  className?: string;
  summary?: boolean;
  /** Whether this is a draft workspace (shows "Draft" instead of elapsed time) */
  isDraft?: boolean;
  onOpenWorkspaceActions?: (workspaceId: string) => void;
}

export function WorkspaceSummary({
  name,
  workspaceId,
  filesChanged,
  linesAdded,
  linesRemoved,
  isActive = false,
  isRunning = false,
  isPinned = false,
  hasPendingApproval = false,
  hasRunningDevServer = false,
  hasUnseenActivity = false,
  latestProcessCompletedAt,
  latestProcessStatus,
  prStatus,
  contextUsage,
  onClick,
  className,
  summary = false,
  isDraft = false,
  onOpenWorkspaceActions,
}: WorkspaceSummaryProps) {
  const { t } = useTranslation('common');
  const hasChanges = filesChanged !== undefined && filesChanged > 0;
  const isFailed =
    latestProcessStatus === 'failed' || latestProcessStatus === 'killed';
  const needsAttention =
    hasPendingApproval || (hasUnseenActivity && !isRunning);
  const showMeta = !summary || isActive;

  const handleOpenCommandBar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!workspaceId || !onOpenWorkspaceActions) return;
    onOpenWorkspaceActions(workspaceId);
  };

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-md border bg-card shadow-sm transition-colors duration-100',
        isActive
          ? 'border-brand-on-surface bg-sel'
          : 'border-border hover:bg-secondary',
        className
      )}
    >
      {/* Attention accent - thin colored bar on the left edge */}
      {needsAttention && (
        <span
          className="absolute inset-y-0 left-0 w-[3px] bg-brand-on-surface"
          aria-hidden="true"
        />
      )}

      <button
        onClick={onClick}
        className={cn(
          'flex w-full cursor-pointer flex-col gap-half p-3 text-left transition-colors duration-150',
          isActive ? 'text-high' : 'text-normal hover:text-high'
        )}
      >
        {/* Header: name + status icons */}
        <div className="flex w-full items-center gap-half">
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-medium',
              isActive ? 'text-high' : 'text-normal'
            )}
          >
            {name}
          </span>

          {/* Dev server running */}
          {hasRunningDevServer && (
            <PlayIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* Pending approval - raised hand */}
          {hasPendingApproval && (
            <HandIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* Failed/killed status (only when not running) */}
          {!isRunning && isFailed && (
            <TriangleIcon
              className="size-icon-xs text-error shrink-0"
              weight="fill"
            />
          )}

          {/* Unseen activity indicator (only when not running and not failed) */}
          {hasUnseenActivity && !isRunning && !isFailed && (
            <CircleIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* PR status icon */}
          {prStatus === 'open' && (
            <GitPullRequestIcon
              className="size-icon-xs text-success shrink-0"
              weight="fill"
            />
          )}
          {prStatus === 'merged' && (
            <GitPullRequestIcon
              className="size-icon-xs text-merged shrink-0"
              weight="fill"
            />
          )}

          {/* Pin icon */}
          {isPinned && (
            <PushPinIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* Context window usage gauge */}
          {contextUsage && (
            <ContextUsageGauge
              tokenUsageInfo={{
                total_tokens: contextUsage.totalTokens,
                model_context_window: contextUsage.contextWindow,
              }}
              className="-my-1 shrink-0 !p-0"
            />
          )}
        </div>

        {/* Indeterminate progress bar while the agent is working */}
        {showMeta && isRunning && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full',
                hasPendingApproval
                  ? 'w-full bg-brand-on-surface/40'
                  : 'w-1/3 bg-success animate-progress-indeterminate'
              )}
            />
          </div>
        )}

        {/* Footer: activity/time + change stats */}
        {showMeta && (
          <div className="flex h-[17px] w-full items-center justify-between gap-base text-xs text-low">
            <span className="flex min-w-0 items-center gap-half truncate">
              {isRunning ? (
                hasPendingApproval ? (
                  t('workspaces.activityWaitingApproval')
                ) : (
                  t('workspaces.activityWorking')
                )
              ) : isDraft ? (
                t('workspaces.draft')
              ) : latestProcessCompletedAt ? (
                <>
                  <ClockIcon className="size-icon-xs shrink-0" />
                  <span className="truncate">
                    {formatRelativeElapsed(latestProcessCompletedAt)}
                  </span>
                </>
              ) : null}
            </span>

            {/* File count + lines changed on the right */}
            {hasChanges && (
              <span className="flex shrink-0 items-center gap-half text-right">
                <FileIcon className="size-icon-xs" weight="fill" />
                <span>{filesChanged}</span>
                {linesAdded !== undefined && (
                  <span className="text-success">+{linesAdded}</span>
                )}
                {linesRemoved !== undefined && (
                  <span className="text-error">-{linesRemoved}</span>
                )}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Right-side hover action - more options only */}
      {workspaceId && onOpenWorkspaceActions && (
        <div className="absolute right-1.5 top-1.5 sm:opacity-0 sm:group-hover:opacity-100">
          <button
            onClick={handleOpenCommandBar}
            onPointerDown={(e) => e.stopPropagation()}
            className="rounded-sm border border-border bg-card p-1 text-low shadow-sm hover:bg-tertiary hover:text-normal"
            title={t('workspaces.more')}
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </button>
        </div>
      )}
    </div>
  );
}
