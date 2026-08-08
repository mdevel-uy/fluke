import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { InputField } from './InputField';
import { MaterialIcon } from './MaterialIcon';
import {
  WorkspaceSummary,
  type WorkspaceContextUsage,
} from './WorkspaceSummary';
import type { AppBarHostStatus } from './AppBar';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import {
  WorkspaceScopeRail,
  WORKSPACE_SCOPES,
  type WorkspaceScope,
  type WorkspaceRailScope,
  type WorkspaceScopeCounts,
} from './WorkspaceScopeRail';

/**
 * Below this many workspaces the scope rail, the search field and the sort /
 * filter controls are not rendered at all: there is nothing to slice yet, and
 * chrome over an empty list is the bug this replaces.
 */
const CHROME_THRESHOLD = 8;

const SCOPE_LABEL_KEYS: Record<WorkspaceScope, string> = {
  attention: 'common:workspaces.scopes.attention',
  review: 'common:workspaces.scopes.review',
  running: 'common:workspaces.scopes.running',
  idle: 'common:workspaces.scopes.idle',
  all: 'common:workspaces.scopes.all',
};

const TAB_STORAGE_KEY_PREFIX = 'vibe.ui.tab.';

function getInitialScope(persistKey: string | undefined): WorkspaceScope {
  if (!persistKey || typeof window === 'undefined') return 'all';
  try {
    const stored = window.localStorage.getItem(
      `${TAB_STORAGE_KEY_PREFIX}${persistKey}`
    );
    return WORKSPACE_SCOPES.includes(stored as WorkspaceScope)
      ? (stored as WorkspaceScope)
      : 'all';
  } catch {
    return 'all';
  }
}

export interface WorkspacesSidebarWorkspace {
  id: string;
  name: string;
  branch?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  prNumber?: number;
  prUrl?: string;
  prMergeable?: string;
  /** CI rollup of the open PR: "passing" | "failing" | "pending" | "none" | "unknown" */
  prCiStatus?: string;
  contextUsage?: WorkspaceContextUsage | null;
  /** The agent's most recent tool activity (e.g. "Edit: `src/foo.rs`") */
  latestActivity?: string;
  /** GitHub issue backing this workspace's worker task, if any */
  issueNumber?: number;
  /** Worker task is in progress but the agent is no longer running */
  hasStalledTask?: boolean;
  /** Backing worker task ended in failed status */
  hasFailedTask?: boolean;
  /** Backing worker task is in review status (PR open, awaiting reviewer) */
  hasTaskInReview?: boolean;
  /** Backing worker task was approved by the reviewer, PR still open pending merge */
  hasTaskApproved?: boolean;
  /** When the latest coding-agent process started (for elapsed time) */
  latestProcessStartedAt?: string;
  /** Name of the worker that owns this workspace, if any */
  workerName?: string;
  /** Role of the owning worker: developer | analyst | reviewer */
  workerRole?: string;
  /** Model configured for the owning worker, if any */
  workerModel?: string;
  /** Display title of the worker task backing this workspace */
  taskTitle?: string;
}

export interface WorkspacesSidebarPersistKeys {
  statusTab: string;
}

const DEFAULT_PERSIST_KEYS: WorkspacesSidebarPersistKeys = {
  statusTab: 'workspaces-sidebar-status-tab',
};

export interface WorkspacesSidebarProps {
  workspaces: WorkspacesSidebarWorkspace[];
  archivedWorkspaces?: WorkspacesSidebarWorkspace[];
  isLoading?: boolean;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** Whether to show archived workspaces */
  showArchive?: boolean;
  /** Handler for toggling archive view */
  onShowArchiveChange?: (show: boolean) => void;
  /** Handler to load more workspaces on scroll */
  onLoadMore?: () => void;
  /** Whether there are more workspaces to load */
  hasMoreWorkspaces?: boolean;
  /** Controls rendered beside the search input */
  searchControls?: ReactNode;
  /** Callback for opening workspace actions */
  onOpenWorkspaceActions?: (workspaceId: string) => void;
  /** Persist keys for sidebar view state */
  persistKeys?: WorkspacesSidebarPersistKeys;
  activeRemoteHost?: {
    name: string;
    status: AppBarHostStatus;
  } | null;
  onOpenRemoteHostSettings?: () => void;
}

export interface WorkspacesSidebarReopenTagProps {
  active?: boolean;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  ariaLabel?: string;
  className?: string;
}

export function WorkspacesSidebarReopenTag({
  active = false,
  onHoverStart,
  onHoverEnd,
  ariaLabel,
  className,
}: WorkspacesSidebarReopenTagProps) {
  return (
    <button
      type="button"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      aria-label={ariaLabel ?? 'Preview workspaces sidebar'}
      title={ariaLabel ?? 'Preview workspaces sidebar'}
      className={cn(
        'group inline-flex h-24 w-4 items-center justify-center rounded-md border border-border bg-secondary/95 shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 cursor-e-resize',
        active ? 'bg-panel text-normal' : 'text-low hover:text-normal',
        className
      )}
    >
      <span className="grid grid-cols-2 gap-[2px]">
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
        <span className="size-dot rounded-full bg-low/70 group-hover:bg-low" />
      </span>
    </button>
  );
}

function needsAttention(ws: WorkspacesSidebarWorkspace) {
  // Precedence: pending approval > stalled > in review / approved > idle. A
  // task waiting for reviewer feedback or already approved does not "need
  // you" — a reviewer will unblock it, or the merge is imminent — but an
  // explicit approval request from the agent still trumps that.
  if (ws.hasPendingApproval) return true;
  if (ws.hasStalledTask) return true;
  if (ws.hasTaskInReview) return false;
  if (ws.hasTaskApproved) return false;
  return !!ws.hasUnseenActivity && !ws.isRunning;
}

function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
}: {
  workspaces: WorkspacesSidebarWorkspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenWorkspaceActions: (workspaceId: string) => void;
}) {
  return (
    <>
      {workspaces.map((workspace) => (
        <WorkspaceSummary
          key={workspace.id}
          name={workspace.name}
          workspaceId={workspace.id}
          filesChanged={workspace.filesChanged}
          linesAdded={workspace.linesAdded}
          linesRemoved={workspace.linesRemoved}
          isActive={selectedWorkspaceId === workspace.id}
          isRunning={workspace.isRunning}
          isPinned={workspace.isPinned}
          hasPendingApproval={workspace.hasPendingApproval}
          hasRunningDevServer={workspace.hasRunningDevServer}
          hasUnseenActivity={workspace.hasUnseenActivity}
          latestProcessCompletedAt={workspace.latestProcessCompletedAt}
          latestProcessStatus={workspace.latestProcessStatus}
          prStatus={workspace.prStatus}
          prNumber={workspace.prNumber}
          prUrl={workspace.prUrl}
          prMergeable={workspace.prMergeable}
          prCiStatus={workspace.prCiStatus}
          branch={workspace.branch}
          contextUsage={workspace.contextUsage}
          latestActivity={workspace.latestActivity}
          issueNumber={workspace.issueNumber}
          hasStalledTask={workspace.hasStalledTask}
          latestProcessStartedAt={workspace.latestProcessStartedAt}
          workerName={workspace.workerName}
          workerRole={workspace.workerRole}
          workerModel={workspace.workerModel}
          taskTitle={workspace.taskTitle}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
          onClick={() => onSelectWorkspace(workspace.id)}
        />
      ))}
    </>
  );
}

export function WorkspacesSidebar({
  workspaces,
  archivedWorkspaces = [],
  isLoading = false,
  selectedWorkspaceId,
  onSelectWorkspace,
  searchQuery,
  onSearchChange,
  showArchive = false,
  onShowArchiveChange,
  onLoadMore,
  hasMoreWorkspaces = false,
  searchControls,
  onOpenWorkspaceActions,
  persistKeys = DEFAULT_PERSIST_KEYS,
  activeRemoteHost = null,
  onOpenRemoteHostSettings,
}: WorkspacesSidebarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const handleOpenWorkspaceActions = useCallback(
    (workspaceId: string) => {
      onOpenWorkspaceActions?.(workspaceId);
    },
    [onOpenWorkspaceActions]
  );

  // Handle scroll to load more
  const handleScroll = () => {
    if (!hasMoreWorkspaces || !onLoadMore) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Load more when scrolled within 100px of the bottom
    if (scrollHeight - scrollTop - clientHeight < 100) {
      onLoadMore();
    }
  };

  // Selected scope, persisted per sidebar instance
  const [scope, setScope] = useState<WorkspaceScope>(() =>
    getInitialScope(persistKeys.statusTab)
  );

  useEffect(() => {
    if (!persistKeys.statusTab) return;
    try {
      window.localStorage.setItem(
        `${TAB_STORAGE_KEY_PREFIX}${persistKeys.statusTab}`,
        scope
      );
    } catch {
      // Ignore localStorage failures (private mode/quota/security errors).
    }
  }, [persistKeys.statusTab, scope]);

  // Categorize workspaces per scope, preserving the incoming sort order.
  // Attention wins over review, which wins over running/idle, so a workspace
  // is only listed once in the grouped "all" view.
  const scopeWorkspaces = useMemo(() => {
    const attention = workspaces.filter(needsAttention);
    const rest = workspaces.filter((ws) => !needsAttention(ws));
    const review = rest.filter((ws) => ws.hasTaskInReview);
    const restNoReview = rest.filter((ws) => !ws.hasTaskInReview);
    return {
      attention,
      review,
      running: workspaces.filter((ws) => ws.isRunning),
      idle: workspaces.filter((ws) => !ws.isRunning),
      all: workspaces,
      restRunning: restNoReview.filter((ws) => ws.isRunning),
      restIdle: restNoReview.filter((ws) => !ws.isRunning),
    };
  }, [workspaces]);

  const counts: WorkspaceScopeCounts = {
    attention: scopeWorkspaces.attention.length,
    review: scopeWorkspaces.review.length,
    running: scopeWorkspaces.running.length,
    idle: scopeWorkspaces.idle.length,
    all: workspaces.length,
    archive: archivedWorkspaces.length,
  };

  // A persisted scope that has since emptied is a dead end: once the list has
  // loaded, fall through to the first scope that actually has something in it.
  const hasResolvedScopeRef = useRef(false);
  useEffect(() => {
    if (hasResolvedScopeRef.current || isLoading || workspaces.length === 0) {
      return;
    }
    hasResolvedScopeRef.current = true;
    if (scopeWorkspaces[scope].length > 0) return;
    const fallback = WORKSPACE_SCOPES.find(
      (candidate) => scopeWorkspaces[candidate].length > 0
    );
    if (fallback) setScope(fallback);
  }, [isLoading, workspaces.length, scope, scopeWorkspaces]);

  // The rail is permanent chrome; only search/sort/filter wait until the list
  // is big enough to need slicing tools.
  const showSearch = !isLoading && workspaces.length >= CHROME_THRESHOLD;
  const railScope: WorkspaceRailScope = showArchive ? 'archive' : scope;

  const handleScopeChange = useCallback(
    (next: WorkspaceRailScope) => {
      if (next === 'archive') {
        onShowArchiveChange?.(true);
        return;
      }
      if (showArchive) onShowArchiveChange?.(false);
      setScope(next);
    },
    [onShowArchiveChange, showArchive]
  );

  const visibleWorkspaces = scopeWorkspaces[scope];
  const panelTitle = showArchive
    ? t('common:workspaces.archived')
    : t(SCOPE_LABEL_KEYS[scope]);
  const panelCount = showArchive ? archivedWorkspaces.length : counts[scope];

  // "All" is the only scope where the groups add anything: everywhere else the
  // scope itself is the grouping.
  const groups = useMemo(
    () =>
      [
        { id: 'attention' as const, items: scopeWorkspaces.attention },
        { id: 'review' as const, items: scopeWorkspaces.review },
        { id: 'running' as const, items: scopeWorkspaces.restRunning },
        { id: 'idle' as const, items: scopeWorkspaces.restIdle },
      ].filter((group) => group.items.length > 0),
    [scopeWorkspaces]
  );

  return (
    <div className="w-full h-full bg-md-surface-container-lowest flex">
      <WorkspaceScopeRail
        scope={railScope}
        counts={counts}
        onScopeChange={handleScopeChange}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header + Search */}
        <div className="flex flex-col gap-base">
          <CollapsibleSectionHeader
            title={panelTitle}
            count={panelCount}
            collapsible={false}
          />
          {showSearch && (
            <div className="px-base flex items-stretch gap-half">
              <div className="flex-1 min-w-0">
                <InputField
                  variant="search"
                  value={searchQuery}
                  onChange={onSearchChange}
                  placeholder={t('common:workspaces.searchPlaceholder')}
                />
              </div>
              {searchControls}
            </div>
          )}

          {activeRemoteHost && (
            <div className="px-base">
              <div className="rounded-sm border border-border bg-panel/60 px-base py-half flex items-center justify-between gap-base">
                <div className="min-w-0">
                  <p className="text-xs text-low uppercase tracking-wide">
                    {t('common:workspaces.remoteHostLabel', {
                      defaultValue: 'Remote host',
                    })}
                  </p>
                  <p className="text-sm text-high truncate">
                    {activeRemoteHost.name}
                  </p>
                </div>
                <div className="flex items-center gap-half shrink-0">
                  <span
                    className={cn(
                      'inline-flex h-2.5 w-2.5 rounded-full',
                      activeRemoteHost.status === 'online'
                        ? 'bg-success'
                        : activeRemoteHost.status === 'offline'
                          ? 'bg-low'
                          : 'bg-warning'
                    )}
                    aria-hidden="true"
                  />
                  {onOpenRemoteHostSettings && (
                    <button
                      type="button"
                      onClick={onOpenRemoteHostSettings}
                      className="text-xs text-brand-on-surface hover:underline"
                    >
                      {t('common:workspaces.remoteHostManage', {
                        defaultValue: 'Manage',
                      })}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable workspace list */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto py-base"
        >
          {isLoading ? (
            <div className="flex h-full min-h-[220px] items-center justify-center px-base">
              <div className="flex items-center justify-center text-md-on-surface-variant">
                <MaterialIcon
                  name="progress_activity"
                  size="base"
                  className="animate-spin"
                />
              </div>
            </div>
          ) : showArchive ? (
            /* Archived workspaces view */
            <div className="flex flex-col gap-base px-base">
              <span className="text-sm font-medium text-low">
                {t('common:workspaces.archived')}
              </span>
              {archivedWorkspaces.length === 0 ? (
                <span className="text-sm text-low opacity-60">
                  {t('common:workspaces.noArchived')}
                </span>
              ) : (
                archivedWorkspaces.map((workspace) => (
                  <WorkspaceSummary
                    summary
                    key={workspace.id}
                    name={workspace.name}
                    workspaceId={workspace.id}
                    filesChanged={workspace.filesChanged}
                    linesAdded={workspace.linesAdded}
                    linesRemoved={workspace.linesRemoved}
                    isActive={selectedWorkspaceId === workspace.id}
                    isRunning={workspace.isRunning}
                    isPinned={workspace.isPinned}
                    hasPendingApproval={workspace.hasPendingApproval}
                    hasRunningDevServer={workspace.hasRunningDevServer}
                    hasUnseenActivity={workspace.hasUnseenActivity}
                    latestProcessCompletedAt={
                      workspace.latestProcessCompletedAt
                    }
                    latestProcessStatus={workspace.latestProcessStatus}
                    prStatus={workspace.prStatus}
                    prNumber={workspace.prNumber}
                    prUrl={workspace.prUrl}
                    prMergeable={workspace.prMergeable}
                    prCiStatus={workspace.prCiStatus}
                    branch={workspace.branch}
                    contextUsage={workspace.contextUsage}
                    latestActivity={workspace.latestActivity}
                    latestProcessStartedAt={workspace.latestProcessStartedAt}
                    workerName={workspace.workerName}
                    workerRole={workspace.workerRole}
                    workerModel={workspace.workerModel}
                    taskTitle={workspace.taskTitle}
                    onOpenWorkspaceActions={handleOpenWorkspaceActions}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  />
                ))
              )}
            </div>
          ) : (
            /* Scope view */
            <div className="flex flex-col gap-base px-base">
              {visibleWorkspaces.length === 0 ? (
                <span className="text-sm text-low opacity-60">
                  {t('common:workspaces.noWorkspaces')}
                </span>
              ) : scope === 'all' && groups.length > 1 ? (
                groups.map((group) => (
                  <div key={group.id} className="flex flex-col gap-base">
                    <span className="text-label font-semibold uppercase tracking-wider text-low">
                      {t(SCOPE_LABEL_KEYS[group.id])}
                    </span>
                    <WorkspaceList
                      workspaces={group.items}
                      selectedWorkspaceId={selectedWorkspaceId}
                      onSelectWorkspace={onSelectWorkspace}
                      onOpenWorkspaceActions={handleOpenWorkspaceActions}
                    />
                  </div>
                ))
              ) : (
                <WorkspaceList
                  workspaces={visibleWorkspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelectWorkspace={onSelectWorkspace}
                  onOpenWorkspaceActions={handleOpenWorkspaceActions}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
