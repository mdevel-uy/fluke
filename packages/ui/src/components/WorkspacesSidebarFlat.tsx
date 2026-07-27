import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { InputField } from './InputField';
import { MaterialIcon } from './MaterialIcon';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import type { AppBarHostStatus } from './AppBar';
import type {
  WorkspacesSidebarWorkspace,
  WorkspacesSidebarPersistKeys,
} from './WorkspacesSidebar';

// SHELL-SPEC R9/R10/R12: flat workspaces sidebar — dense 22px rows grouped in
// Needs Attention / Running / Idle / Archived sections. Replaces the
// scope-rail + summary-card layout.

export interface WorkspacesSidebarFlatProps {
  workspaces: WorkspacesSidebarWorkspace[];
  archivedWorkspaces?: WorkspacesSidebarWorkspace[];
  isLoading?: boolean;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  isCreateMode?: boolean;
  draftTitle?: string;
  onSelectCreate?: () => void;
  showArchive?: boolean;
  onShowArchiveChange?: (show: boolean) => void;
  onLoadMore?: () => void;
  hasMoreWorkspaces?: boolean;
  searchControls?: ReactNode;
  onOpenWorkspaceActions?: (workspaceId: string) => void;
  persistKeys?: WorkspacesSidebarPersistKeys;
  activeRemoteHost?: { name: string; status: AppBarHostStatus } | null;
  onOpenRemoteHostSettings?: () => void;
}

function needsAttention(ws: WorkspacesSidebarWorkspace) {
  return (
    !!ws.hasPendingApproval ||
    !!ws.hasStalledTask ||
    (!!ws.hasUnseenActivity && !ws.isRunning)
  );
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function attentionReason(
  ws: WorkspacesSidebarWorkspace,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (ws.hasPendingApproval)
    return t('common:workspaces.rowMeta.review', { defaultValue: 'review' });
  if (ws.latestProcessStatus === 'failed')
    return t('common:workspaces.rowMeta.failed', { defaultValue: 'failed' });
  if (ws.hasStalledTask)
    return t('common:workspaces.rowMeta.stalled', { defaultValue: 'stalled' });
  return t('common:workspaces.rowMeta.activity', { defaultValue: 'activity' });
}

type RowVariant = 'attention' | 'running' | 'idle' | 'archived';

function rowDotClass(variant: RowVariant, ws: WorkspacesSidebarWorkspace) {
  if (variant === 'running') return 'bg-brand-on-surface animate-pulse';
  if (variant === 'attention')
    return ws.latestProcessStatus === 'failed' ? 'bg-error' : 'bg-warning';
  if (variant === 'archived') return 'bg-border-strong opacity-50';
  return 'bg-border-strong';
}

function rowMeta(
  variant: RowVariant,
  ws: WorkspacesSidebarWorkspace,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (variant === 'attention') return attentionReason(ws, t);
  if (variant === 'running') {
    const elapsed = timeAgo(ws.latestProcessStartedAt);
    return [ws.workerName, elapsed].filter(Boolean).join(' · ');
  }
  return timeAgo(ws.latestProcessCompletedAt);
}

function WorkspaceRow({
  workspace,
  variant,
  isSelected,
  onSelect,
  onOpenActions,
}: {
  workspace: WorkspacesSidebarWorkspace;
  variant: RowVariant;
  isSelected: boolean;
  onSelect: () => void;
  onOpenActions?: () => void;
}) {
  const { t } = useTranslation();
  const meta = rowMeta(variant, workspace, t);
  return (
    <div
      className={cn(
        'group relative flex w-full items-center gap-2 h-[22px] pl-[22px] pr-2',
        isSelected
          ? 'bg-sel before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-[2px] before:bg-brand-on-surface'
          : 'hover:bg-secondary'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left text-sm cursor-pointer',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
          isSelected
            ? 'text-high'
            : variant === 'archived'
              ? 'text-low'
              : 'text-normal'
        )}
      >
        <span
          className={cn(
            'h-[7px] w-[7px] flex-none rounded-full',
            rowDotClass(variant, workspace)
          )}
          aria-hidden
        />
        <span className="truncate">{workspace.name}</span>
        {meta && (
          <span className="ml-auto flex-none font-mono text-[11px] text-low">
            {meta}
          </span>
        )}
      </button>
      {onOpenActions && (
        <button
          type="button"
          onClick={onOpenActions}
          aria-label="Workspace actions"
          className="hidden group-hover:flex items-center justify-center w-4 h-4 flex-none rounded-sm text-low hover:text-high hover:bg-md-surface-container-high cursor-pointer"
        >
          <MaterialIcon name="more_horiz" size="xs" />
        </button>
      )}
    </div>
  );
}

function Section({
  persistKey,
  title,
  items,
  variant,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
  defaultOpen = true,
}: {
  persistKey: string;
  title: string;
  items: WorkspacesSidebarWorkspace[];
  variant: RowVariant;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenWorkspaceActions?: (workspaceId: string) => void;
  defaultOpen?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex-none">
      <CollapsibleSectionHeader
        persistKey={persistKey}
        title={title}
        count={items.length}
        defaultExpanded={defaultOpen}
      >
        <div className="flex flex-col">
          {items.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              variant={variant}
              isSelected={ws.id === selectedWorkspaceId}
              onSelect={() => onSelectWorkspace(ws.id)}
              onOpenActions={
                onOpenWorkspaceActions
                  ? () => onOpenWorkspaceActions(ws.id)
                  : undefined
              }
            />
          ))}
        </div>
      </CollapsibleSectionHeader>
    </div>
  );
}

export function WorkspacesSidebarFlat({
  workspaces,
  archivedWorkspaces = [],
  isLoading = false,
  selectedWorkspaceId,
  onSelectWorkspace,
  searchQuery,
  onSearchChange,
  isCreateMode = false,
  draftTitle,
  onSelectCreate,
  onLoadMore,
  hasMoreWorkspaces = false,
  searchControls,
  onOpenWorkspaceActions,
  activeRemoteHost,
  onOpenRemoteHostSettings,
}: WorkspacesSidebarFlatProps) {
  const { t } = useTranslation();

  const groups = useMemo(() => {
    const attention = workspaces.filter(needsAttention);
    const rest = workspaces.filter((ws) => !needsAttention(ws));
    return {
      attention,
      running: rest.filter((ws) => ws.isRunning),
      idle: rest.filter((ws) => !ws.isRunning),
    };
  }, [workspaces]);

  // No create action here: workspaces are born from assigning an issue to a
  // worker, never created by hand.
  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('common:workspaces.title', { defaultValue: 'Workspaces' })}
          collapsible={false}
          className="border-b"
        />
      </div>

      {activeRemoteHost && (
        <button
          type="button"
          onClick={onOpenRemoteHostSettings}
          className="flex-none mx-2 mt-1.5 flex items-center gap-2 rounded-sm border border-border bg-panel/60 px-2 py-1 text-left text-xs text-normal hover:bg-secondary cursor-pointer"
        >
          <span
            className={cn(
              'h-2 w-2 flex-none rounded-full',
              activeRemoteHost.status === 'online'
                ? 'bg-success'
                : 'bg-md-outline'
            )}
            aria-hidden
          />
          <span className="truncate">{activeRemoteHost.name}</span>
        </button>
      )}

      <div className="px-base py-half flex-none flex items-stretch gap-half">
        <div className="min-w-0 flex-1">
          <InputField
            variant="search"
            value={searchQuery}
            onChange={onSearchChange}
            placeholder={t('common:workspaces.searchPlaceholder', {
              defaultValue: 'Search workspaces…',
            })}
          />
        </div>
        {searchControls}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {isCreateMode && (
          <div className="flex-none">
            <WorkspaceRow
              workspace={{
                id: '__create__',
                name:
                  draftTitle ||
                  t('common:workspaces.newWorkspace', {
                    defaultValue: 'New Workspace',
                  }),
              }}
              variant="idle"
              isSelected
              onSelect={() => onSelectCreate?.()}
            />
          </div>
        )}

        <Section
          persistKey="ws-flat-attention"
          title={t('common:workspaces.scopes.attention', {
            defaultValue: 'Needs attention',
          })}
          items={groups.attention}
          variant="attention"
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
        />
        <Section
          persistKey="ws-flat-running"
          title={t('common:workspaces.scopes.running', {
            defaultValue: 'Running',
          })}
          items={groups.running}
          variant="running"
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
        />
        <Section
          persistKey="ws-flat-idle"
          title={t('common:workspaces.scopes.idle', { defaultValue: 'Idle' })}
          items={groups.idle}
          variant="idle"
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
        />
        <Section
          persistKey="ws-flat-archived"
          title={t('common:workspaces.archivedTitle', {
            defaultValue: 'Archived',
          })}
          items={archivedWorkspaces}
          variant="archived"
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
          defaultOpen={false}
        />

        {isLoading && (
          <div className="flex items-center justify-center py-4">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-on-surface-variant"
            />
          </div>
        )}

        {!isLoading && hasMoreWorkspaces && onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            className="mx-2 mt-1.5 flex h-[22px] items-center justify-center rounded-sm text-xs text-brand-on-surface hover:bg-secondary cursor-pointer w-[calc(100%-16px)]"
          >
            {t('common:workspaces.loadMore', { defaultValue: 'Load more' })}
          </button>
        )}
      </div>
    </div>
  );
}
