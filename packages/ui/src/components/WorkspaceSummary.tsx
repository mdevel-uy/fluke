import { useState } from 'react';
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
  CaretDownIcon,
  CaretUpIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';

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

/** Compact duration since a timestamp: 45s, 12m, 3h, 2d */
const formatDurationSince = (dateString: string): string => {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s`;
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
};

const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-brand/10 text-brand-on-surface',
  reviewer: 'bg-warning/10 text-warning',
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
  /** GitHub issue backing this workspace's worker task, if any */
  issueNumber?: number;
  /** Worker task is in progress but the agent is no longer running */
  hasStalledTask?: boolean;
  /** Name of the worker that owns this workspace, if any */
  workerName?: string;
  /** Role of the owning worker: developer | analyst | reviewer */
  workerRole?: string;
  /** Model configured for the owning worker, if any */
  workerModel?: string;
  /** Display title of the worker task backing this workspace */
  taskTitle?: string;
  /** Git branch of the workspace */
  branch?: string;
  /** PR number, if a PR exists */
  prNumber?: number;
  /** PR URL, if a PR exists */
  prUrl?: string;
  /** Mergeable state of the open PR: "mergeable" | "conflicting" | "unknown" */
  prMergeable?: string;
  /** CI rollup of the open PR: "passing" | "failing" | "pending" | "none" | "unknown" */
  prCiStatus?: string;
  /** The agent's most recent tool activity (e.g. "Edit: `src/foo.rs`") */
  latestActivity?: string;
  /** When the latest coding-agent process started (for elapsed time) */
  latestProcessStartedAt?: string;
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
  issueNumber,
  hasStalledTask = false,
  workerName,
  workerRole,
  workerModel,
  taskTitle,
  branch,
  prNumber,
  prUrl,
  prMergeable,
  prCiStatus,
  latestActivity,
  latestProcessStartedAt,
  onClick,
  className,
  summary = false,
  isDraft = false,
  onOpenWorkspaceActions,
}: WorkspaceSummaryProps) {
  const { t } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChanges = filesChanged !== undefined && filesChanged > 0;
  const isFailed =
    latestProcessStatus === 'failed' || latestProcessStatus === 'killed';
  const needsAttention =
    hasPendingApproval || hasStalledTask || (hasUnseenActivity && !isRunning);
  const showMeta = !summary || isActive;
  const isWorkerCard = Boolean(workerName || taskTitle);
  const isExpandable =
    showMeta && (isWorkerCard || Boolean(branch || prNumber));
  const showStatusDot =
    isWorkerCard || isRunning || hasPendingApproval || hasStalledTask;

  const contextPct =
    contextUsage && contextUsage.contextWindow > 0
      ? Math.min(
          100,
          (contextUsage.totalTokens / contextUsage.contextWindow) * 100
        )
      : null;

  // Issue link derived from the PR URL (same repo): .../pull/N -> .../issues/N
  const issueUrl =
    issueNumber != null && prUrl
      ? `${prUrl.replace(/\/pull\/\d+.*$/, '')}/issues/${issueNumber}`
      : undefined;

  const lastActivityAt = latestProcessCompletedAt ?? latestProcessStartedAt;

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
        {/* Header: status dot + worker/workspace name + role chip + status icons */}
        <div
          className={cn(
            'flex w-full items-center gap-half',
            isExpandable && 'pr-5'
          )}
        >
          {showStatusDot && (
            <span
              className={cn(
                'h-[7px] w-[7px] shrink-0 rounded-full',
                hasStalledTask || isFailed
                  ? 'bg-error'
                  : hasPendingApproval
                    ? 'bg-warning'
                    : isRunning
                      ? 'animate-pulse bg-success'
                      : 'bg-success'
              )}
              aria-hidden="true"
            />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-body',
              isWorkerCard
                ? 'font-semibold text-high'
                : cn('font-medium', isActive ? 'text-high' : 'text-normal')
            )}
          >
            {workerName ?? name}
          </span>

          {isWorkerCard && workerRole && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold leading-4',
                ROLE_CHIP_CLASS[workerRole] ?? 'bg-secondary text-normal'
              )}
            >
              {t(`workers.roles.${workerRole}`)}
            </span>
          )}

          {isWorkerCard && workerModel && (
            <span className="shrink-0 rounded bg-merged/10 px-1.5 py-px font-mono text-[10px] leading-4 text-merged">
              {workerModel}
            </span>
          )}

          {/* Backing GitHub issue (only in the header when there is no task line) */}
          {!isWorkerCard && issueNumber != null && (
            <span className="inline-flex shrink-0 items-center rounded border border-border/60 bg-secondary px-1.5 py-px font-mono text-[11px] leading-4 text-normal">
              #{issueNumber}
            </span>
          )}

          {/* Legacy status icons stay off worker cards: the mock keeps their
              header to dot + name + chips, and the same signals live in the
              status dot, the meta row, and the expanded panel. */}

          {/* Dev server running */}
          {hasRunningDevServer && (
            <PlayIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* Pending approval - raised hand */}
          {!isWorkerCard && hasPendingApproval && (
            <HandIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* Failed/killed status (only when not running) */}
          {!isWorkerCard && !isRunning && isFailed && (
            <TriangleIcon
              className="size-icon-xs text-error shrink-0"
              weight="fill"
            />
          )}

          {/* Unseen activity indicator (only when not running and not failed) */}
          {!isWorkerCard && hasUnseenActivity && !isRunning && !isFailed && (
            <CircleIcon
              className="size-icon-xs text-brand-on-surface shrink-0"
              weight="fill"
            />
          )}

          {/* PR status icon */}
          {!isWorkerCard && prStatus === 'open' && (
            <GitPullRequestIcon
              className="size-icon-xs text-success shrink-0"
              weight="fill"
            />
          )}
          {!isWorkerCard && prStatus === 'merged' && (
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
        </div>

        {/* Task line: issue badge + task title */}
        {isWorkerCard && (
          <div className="flex w-full items-center gap-half">
            {issueNumber != null && (
              <span className="inline-flex shrink-0 items-center rounded border border-border/60 bg-secondary px-1.5 py-px font-mono text-[11px] leading-4 text-normal">
                #{issueNumber}
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate text-xs text-high"
              title={taskTitle ?? name}
            >
              {taskTitle ?? name}
            </span>
          </div>
        )}

        {/* Context usage bar: fills with % of the agent's context window */}
        {showMeta && contextPct !== null && (
          <div className="flex w-full items-center gap-base">
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

        {/* Footer: activity/time + change stats */}
        {showMeta && (
          <div className="flex h-[17px] w-full items-center justify-between gap-base text-xs text-low">
            <span className="flex min-w-0 items-center gap-half truncate">
              {isRunning ? (
                hasPendingApproval ? (
                  <span className="flex min-w-0 items-center gap-half truncate rounded bg-warning/10 px-1.5 py-px font-medium text-warning">
                    <HandIcon
                      className="size-icon-xs shrink-0"
                      weight="fill"
                      aria-hidden
                    />
                    <span className="truncate">
                      {t('workspaces.activityWaitingApproval')}
                    </span>
                  </span>
                ) : (
                  <>
                    {t('workspaces.activityWorking')}
                    {latestProcessStartedAt && (
                      <span className="tabular-nums">
                        · {formatDurationSince(latestProcessStartedAt)}
                      </span>
                    )}
                  </>
                )
              ) : hasStalledTask ? (
                <span
                  className="flex min-w-0 items-center gap-half truncate font-medium text-error"
                  title={t('workspaces.stalledTask')}
                >
                  <TriangleIcon
                    className="size-icon-xs shrink-0"
                    weight="fill"
                    aria-hidden
                  />
                  <span className="truncate">
                    {t('workers.card.stalledShort')}
                    {lastActivityAt && (
                      <span className="tabular-nums">
                        {' '}
                        · {formatDurationSince(lastActivityAt)}
                      </span>
                    )}
                  </span>
                </span>
              ) : isDraft ? (
                t('workspaces.draft')
              ) : latestProcessCompletedAt ? (
                <>
                  <ClockIcon className="size-icon-xs shrink-0" />
                  <span className="truncate">
                    {formatRelativeElapsed(latestProcessCompletedAt)}
                    {prStatus === 'merged' && prNumber != null && (
                      <span className="text-merged">
                        {' '}
                        · {t('workspaces.prMerged', { number: prNumber })}
                      </span>
                    )}
                    {isWorkerCard &&
                      prStatus === 'open' &&
                      prNumber != null && (
                        <span className="text-success">
                          {' '}
                          · {t('workspaces.prOpen', { number: prNumber })}
                        </span>
                      )}
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

      {/* Expanded details: task/PR info without leaving the sidebar */}
      {isExpandable && isExpanded && (
        <div className="flex flex-col gap-half border-t border-border px-3 py-2 text-xs">
          {issueNumber != null && (
            <div className="flex items-baseline gap-base">
              <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-low">
                {t('workspaces.details.issue')}
              </span>
              <span className="min-w-0 flex-1 truncate text-normal">
                #{issueNumber}
                {taskTitle ? ` · ${taskTitle}` : ''}
              </span>
            </div>
          )}
          {prNumber != null && (
            <div className="flex items-baseline gap-base">
              <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-low">
                {t('workspaces.details.pr')}
              </span>
              <span className="min-w-0 flex-1 truncate text-normal">
                #{prNumber}
                {prStatus && (
                  <span
                    className={cn(
                      'font-medium',
                      prStatus === 'open' && 'text-success',
                      prStatus === 'merged' && 'text-merged',
                      prStatus === 'closed' && 'text-error'
                    )}
                  >
                    {' '}
                    {t(`workspaces.details.prStatus.${prStatus}`)}
                  </span>
                )}
                {prStatus === 'open' && prCiStatus === 'passing' && (
                  <span className="text-success">
                    {' '}
                    · {t('workspaces.details.ciPassing')}
                  </span>
                )}
                {prStatus === 'open' && prCiStatus === 'failing' && (
                  <span className="text-error">
                    {' '}
                    · {t('workspaces.details.ciFailing')}
                  </span>
                )}
                {prStatus === 'open' && prCiStatus === 'pending' && (
                  <span> · {t('workspaces.details.ciPending')}</span>
                )}
                {prMergeable === 'conflicting' && (
                  <span className="text-error">
                    {' '}
                    · {t('workspaces.details.conflicting')}
                  </span>
                )}
                {prStatus === 'open' && prMergeable === 'mergeable' && (
                  <span> · {t('workspaces.details.mergeable')}</span>
                )}
              </span>
            </div>
          )}
          {branch && (
            <div className="flex items-baseline gap-base">
              <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-low">
                {t('workspaces.details.branch')}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-normal"
                title={branch}
              >
                {branch}
              </span>
            </div>
          )}
          {lastActivityAt && (
            <div className="flex items-baseline gap-base">
              <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-low">
                {t('workspaces.details.lastActivity')}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-normal"
                title={latestActivity?.replace(/`/g, '')}
              >
                {formatRelativeElapsed(lastActivityAt)}
                {latestActivity && ` — ${latestActivity.replace(/`/g, '')}`}
              </span>
            </div>
          )}
          <div className="mt-half flex items-center gap-base">
            <button
              type="button"
              onClick={onClick}
              className="rounded-sm bg-brand px-2 py-0.5 text-[11px] font-medium text-on-brand hover:bg-brand-hover"
            >
              {t('workspaces.details.openWorkspace')}
            </button>
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm border border-border bg-card px-2 py-0.5 text-[11px] text-normal hover:bg-tertiary hover:text-high"
              >
                {t('workspaces.details.viewPr')}
              </a>
            )}
            {issueUrl && (
              <a
                href={issueUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm border border-border bg-card px-2 py-0.5 text-[11px] text-normal hover:bg-tertiary hover:text-high"
              >
                {t('workspaces.details.viewIssue')}
              </a>
            )}
          </div>
        </div>
      )}

      {/* Expand/collapse toggle - top right corner */}
      {isExpandable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded((v) => !v);
          }}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded ? t('workspaces.collapse') : t('workspaces.expand')
          }
          title={isExpanded ? t('workspaces.collapse') : t('workspaces.expand')}
          className="absolute right-1.5 top-1.5 rounded-sm p-1 text-low hover:bg-tertiary hover:text-normal"
        >
          {isExpanded ? (
            <CaretUpIcon className="size-3" weight="bold" />
          ) : (
            <CaretDownIcon className="size-3" weight="bold" />
          )}
        </button>
      )}

      {/* Right-side hover action - more options only */}
      {workspaceId && onOpenWorkspaceActions && (
        <div
          className={cn(
            'absolute top-1.5 sm:opacity-0 sm:group-hover:opacity-100',
            isExpandable ? 'right-8' : 'right-1.5'
          )}
        >
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
