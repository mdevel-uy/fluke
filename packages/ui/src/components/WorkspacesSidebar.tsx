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
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from './CollapsibleSectionHeader';

export type WorkspaceStatusTab = 'running' | 'idle' | 'all';

const STATUS_TABS: WorkspaceStatusTab[] = ['running', 'idle', 'all'];

const STATUS_TAB_LABEL_KEYS: Record<WorkspaceStatusTab, string> = {
  running: 'common:workspaces.running',
  idle: 'common:workspaces.idle',
  all: 'common:workspaces.all',
};

const TAB_STORAGE_KEY_PREFIX = 'vibe.ui.tab.';

function getInitialStatusTab(
  persistKey: string | undefined
): WorkspaceStatusTab {
  if (!persistKey || typeof window === 'undefined') return 'all';
  try {
    const stored = window.localStorage.getItem(
      `${TAB_STORAGE_KEY_PREFIX}${persistKey}`
    );
    return STATUS_TABS.includes(stored as WorkspaceStatusTab)
      ? (stored as WorkspaceStatusTab)
      : 'all';
  } catch {
    return 'all';
  }
}

export interface WorkspacesSidebarWorkspace {
  id: string;
  name: string;
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
  contextUsage?: WorkspaceContextUsage | null;
  /** GitHub issue backing this workspace's worker task, if any */
  issueNumber?: number;
  /** Worker task is in progress but the agent is no longer running */
  hasStalledTask?: boolean;
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
  onAddWorkspace?: () => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** Whether we're in create mode */
  isCreateMode?: boolean;
  /** Title extracted from draft message (only shown when isCreateMode and non-empty) */
  draftTitle?: string;
  /** Handler to navigate back to create mode */
  onSelectCreate?: () => void;
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
  return (
    !!ws.hasPendingApproval ||
    !!ws.hasStalledTask ||
    (!!ws.hasUnseenActivity && !ws.isRunning)
  );
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
          contextUsage={workspace.contextUsage}
          issueNumber={workspace.issueNumber}
          hasStalledTask={workspace.hasStalledTask}
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
  onAddWorkspace,
  searchQuery,
  onSearchChange,
  isCreateMode = false,
  draftTitle,
  onSelectCreate,
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

  // Selected status tab, persisted per sidebar instance
  const [statusTab, setStatusTab] = useState<WorkspaceStatusTab>(() =>
    getInitialStatusTab(persistKeys.statusTab)
  );

  useEffect(() => {
    if (!persistKeys.statusTab) return;
    try {
      window.localStorage.setItem(
        `${TAB_STORAGE_KEY_PREFIX}${persistKeys.statusTab}`,
        statusTab
      );
    } catch {
      // Ignore localStorage failures (private mode/quota/security errors).
    }
  }, [persistKeys.statusTab, statusTab]);

  // Categorize workspaces per status tab, preserving the incoming sort order.
  const tabWorkspaces = useMemo(
    () => ({
      running: workspaces.filter((ws) => ws.isRunning),
      idle: workspaces.filter((ws) => !ws.isRunning),
      all: workspaces,
    }),
    [workspaces]
  );

  const visibleWorkspaces = tabWorkspaces[statusTab];

  const headerActions: SectionAction[] = [
    {
      materialIcon: 'add',
      onClick: () => onAddWorkspace?.(),
    },
  ];

  return (
    <div className="w-full h-full bg-md-surface-container-lowest flex flex-col">
      {/* Header + Search */}
      <div className="flex flex-col gap-base">
        <CollapsibleSectionHeader
          title={t('common:workspaces.title')}
          collapsible={false}
          actions={headerActions}
          className="border-b"
        />
        {!isLoading && (
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

        {!isLoading && !showArchive && (
          <div
            role="tablist"
            className="flex items-stretch gap-base border-b border-md-outline-variant px-base"
          >
            {STATUS_TABS.map((tab) => {
              const isActive = statusTab === tab;
              const hasAttention = tabWorkspaces[tab].some(needsAttention);
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setStatusTab(tab)}
                  className={cn(
                    'relative -mb-px flex items-center gap-1 border-b-2 px-half py-half text-label uppercase tracking-wider transition-colors duration-150',
                    isActive
                      ? 'border-md-primary font-semibold text-md-primary'
                      : 'border-transparent text-md-on-surface-variant hover:text-md-on-surface'
                  )}
                >
                  {t(STATUS_TAB_LABEL_KEYS[tab])}
                  {hasAttention && (
                    <span
                      className="size-dot shrink-0 rounded-full bg-md-primary"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
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
                  latestProcessCompletedAt={workspace.latestProcessCompletedAt}
                  latestProcessStatus={workspace.latestProcessStatus}
                  prStatus={workspace.prStatus}
                  contextUsage={workspace.contextUsage}
                  onOpenWorkspaceActions={handleOpenWorkspaceActions}
                  onClick={() => onSelectWorkspace(workspace.id)}
                />
              ))
            )}
          </div>
        ) : (
          /* Status tab view */
          <div className="flex flex-col gap-base px-base">
            {draftTitle && (
              <WorkspaceSummary
                name={draftTitle}
                isActive={isCreateMode}
                isDraft={true}
                onClick={onSelectCreate}
              />
            )}
            {visibleWorkspaces.length === 0 && !draftTitle ? (
              <span className="text-sm text-low opacity-60">
                {t('common:workspaces.noWorkspaces')}
              </span>
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

      {/* Fixed footer toggle - only show if there are archived workspaces */}
      <div className="border-t border-primary p-base">
        <button
          onClick={() => onShowArchiveChange?.(!showArchive)}
          className="w-full flex items-center gap-base text-sm text-low hover:text-normal transition-colors duration-100"
        >
          {showArchive ? (
            <>
              <MaterialIcon name="arrow_back" size="xs" />
              <span>{t('common:workspaces.backToActive')}</span>
            </>
          ) : (
            <>
              <MaterialIcon name="archive" size="xs" />
              <span>{t('common:workspaces.viewArchive')}</span>
              <span className="ml-auto text-xs bg-tertiary px-1.5 py-0.5 rounded">
                {archivedWorkspaces.length}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
