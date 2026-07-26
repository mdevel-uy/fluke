import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
} from './Popover';
import { Tooltip } from './Tooltip';
import { MaterialIcon } from './MaterialIcon';
import { useTranslation } from 'react-i18next';

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface AppBarProps {
  projects: AppBarProject[];
  hosts?: AppBarHost[];
  onPairHostClick?: () => void;
  activeHostId?: string | null;
  onCreateProject: () => void;
  onExportClick?: () => void;
  onWorkspacesClick: () => void;
  onDashboardClick?: () => void;
  onSprintClick?: () => void;
  onIssuesClick?: () => void;
  onWorkersClick?: () => void;
  onAnalystDeskClick?: () => void;
  onHostClick?: (hostId: string, status: AppBarHostStatus) => void;
  showWorkspacesButton?: boolean;
  showDashboardButton?: boolean;
  showSprintButton?: boolean;
  showIssuesButton?: boolean;
  showWorkersButton?: boolean;
  showAnalystDeskButton?: boolean;
  onProjectClick: (projectId: string) => void;
  onProjectsDragEnd: (result: DropResult) => void;
  isSavingProjectOrder?: boolean;
  isWorkspacesActive: boolean;
  isDashboardActive?: boolean;
  isSprintActive?: boolean;
  isIssuesActive?: boolean;
  isWorkersActive?: boolean;
  isAnalystDeskActive?: boolean;
  isExportActive?: boolean;
  activeProjectId: string | null;
  isSignedIn?: boolean;
  isLoadingProjects?: boolean;
  onSignIn?: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  notificationBell?: ReactNode;
  userPopover?: ReactNode;
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;
  onOpenSettings?: () => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export interface AppBarProject {
  id: string;
  name: string;
  color: string;
}

export type AppBarHostStatus = 'online' | 'offline' | 'unpaired';

export interface AppBarHost {
  id: string;
  name: string;
  status: AppBarHostStatus;
}

function getHostStatusLabel(status: AppBarHostStatus): string {
  if (status === 'online') return 'Online';
  if (status === 'offline') return 'Offline';
  return 'Unpaired';
}

function getHostStatusIndicatorClass(status: AppBarHostStatus): string {
  if (status === 'online') return 'bg-success';
  if (status === 'offline') return 'bg-md-outline';
  return 'bg-white border-warning';
}

const appBarItemBase =
  'flex items-center rounded-sm text-sm font-normal transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand';

const appBarItemCollapsedLayout = 'justify-center w-10 h-10';
const appBarItemExpandedLayout = 'justify-start w-full h-10 gap-3 px-2';

function getAppBarItemLayoutClass(isCollapsed: boolean): string {
  return isCollapsed ? appBarItemCollapsedLayout : appBarItemExpandedLayout;
}

type AppBarSection = {
  key: 'local' | 'remote' | 'projects' | 'export';
  label: string;
  items: AppBarSectionItem[];
};

type AppBarSectionItem =
  | {
      key: string;
      kind: 'icon-button';
      label: string;
      materialIcon: string;
      isActive?: boolean;
      onClick?: () => void;
      className?: string;
      wrapperClassName?: string;
    }
  | {
      key: string;
      kind: 'host-button';
      host: AppBarHost;
      isActive: boolean;
      onClick?: () => void;
      wrapperClassName?: string;
    }
  | {
      key: string;
      kind: 'kanban-cta';
      label: string;
      onSignIn?: () => void;
    }
  | {
      key: string;
      kind: 'loading';
    }
  | {
      key: string;
      kind: 'project-list';
      projects: AppBarProject[];
      activeProjectId: string | null;
      isSavingProjectOrder?: boolean;
      onProjectClick: (projectId: string) => void;
      onProjectsDragEnd: (result: DropResult) => void;
    };

function getStandardAppBarButtonClassName({
  isActive = false,
  isCollapsed = true,
  className,
}: {
  isActive?: boolean;
  isCollapsed?: boolean;
  className?: string;
}) {
  return cn(
    appBarItemBase,
    getAppBarItemLayoutClass(isCollapsed),
    'cursor-pointer',
    isActive
      ? 'relative text-md-on-surface before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-brand-on-surface'
      : 'text-md-outline hover:text-md-on-surface',
    className
  );
}

function getHostButtonClassName({
  host,
  isActive,
  isCollapsed = true,
}: {
  host: AppBarHost;
  isActive: boolean;
  isCollapsed?: boolean;
}) {
  const isOffline = host.status === 'offline';
  return cn(
    appBarItemBase,
    getAppBarItemLayoutClass(isCollapsed),
    isOffline
      ? 'text-md-outline opacity-50 cursor-not-allowed'
      : isActive
        ? 'relative bg-md-surface-container-high text-md-on-surface cursor-pointer before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-brand-on-surface'
        : host.status === 'unpaired'
          ? 'text-warning cursor-pointer hover:bg-warning/10'
          : 'text-md-outline cursor-pointer hover:text-md-on-surface'
  );
}

export function AppBar({
  hosts = [],
  onPairHostClick,
  activeHostId = null,
  onExportClick,
  onWorkspacesClick,
  onDashboardClick,
  onSprintClick,
  onIssuesClick,
  onWorkersClick,
  onAnalystDeskClick,
  onHostClick,
  showWorkspacesButton = true,
  showDashboardButton = true,
  showSprintButton = true,
  showIssuesButton = true,
  showWorkersButton = true,
  showAnalystDeskButton = true,
  isWorkspacesActive,
  isDashboardActive = false,
  isSprintActive = false,
  isIssuesActive = false,
  isWorkersActive = false,
  isAnalystDeskActive = false,
  isExportActive = false,
  isSignedIn,
  onHoverStart,
  onHoverEnd,
  notificationBell,
  userPopover,
  updateVersion,
  onUpdateClick,
  onOpenSettings,
  isCollapsed = true,
  onToggleCollapsed,
}: AppBarProps) {
  const { t } = useTranslation('common');
  const sections: AppBarSection[] = [];

  function maybeTooltip(
    content: string,
    side: 'top' | 'bottom' | 'left' | 'right',
    enabled: boolean,
    children: ReactNode
  ): ReactNode {
    if (!enabled) return children;
    return (
      <Tooltip content={content} side={side}>
        {children}
      </Tooltip>
    );
  }

  if (
    showWorkspacesButton ||
    showDashboardButton ||
    showSprintButton ||
    showIssuesButton ||
    showWorkersButton ||
    showAnalystDeskButton
  ) {
    const localItems: AppBarSectionItem[] = [];
    if (showDashboardButton && onDashboardClick) {
      localItems.push({
        key: 'local-dashboard',
        kind: 'icon-button',
        label: t('appBar.dashboard'),
        materialIcon: 'space_dashboard',
        isActive: isDashboardActive,
        onClick: onDashboardClick,
      });
    }
    if (showWorkspacesButton) {
      localItems.push({
        key: 'local-workspaces',
        kind: 'icon-button',
        label: t('appBar.workspaces'),
        materialIcon: 'view_quilt',
        isActive: isWorkspacesActive,
        onClick: onWorkspacesClick,
      });
    }
    if (showSprintButton && onSprintClick) {
      localItems.push({
        key: 'local-sprint',
        kind: 'icon-button',
        label: t('appBar.sprint'),
        materialIcon: 'view_kanban',
        isActive: isSprintActive,
        onClick: onSprintClick,
      });
    }
    if (showIssuesButton && onIssuesClick) {
      localItems.push({
        key: 'local-issues',
        kind: 'icon-button',
        label: t('appBar.issues'),
        materialIcon: 'list_alt',
        isActive: isIssuesActive,
        onClick: onIssuesClick,
      });
    }
    if (showWorkersButton && onWorkersClick) {
      localItems.push({
        key: 'local-workers',
        kind: 'icon-button',
        label: t('appBar.workers'),
        materialIcon: 'group',
        isActive: isWorkersActive,
        onClick: onWorkersClick,
      });
    }
    if (showAnalystDeskButton && onAnalystDeskClick) {
      localItems.push({
        key: 'local-analyst-desk',
        kind: 'icon-button',
        label: t('appBar.analystDesk'),
        materialIcon: 'support_agent',
        isActive: isAnalystDeskActive,
        onClick: onAnalystDeskClick,
      });
    }
    if (localItems.length > 0) {
      sections.push({ key: 'local', label: 'Local', items: localItems });
    }
  }

  if (hosts.length > 0 || onPairHostClick) {
    sections.push({
      key: 'remote',
      label: 'Remote',
      items: [
        ...hosts.map((host) => ({
          key: `host-${host.id}`,
          kind: 'host-button' as const,
          host,
          isActive: host.id === activeHostId,
          onClick: () => {
            if (host.status === 'offline') return;
            onHostClick?.(host.id, host.status);
          },
        })),
        ...(onPairHostClick
          ? [
              {
                key: 'pair-remote-device',
                kind: 'icon-button' as const,
                label: 'Pair a remote device',
                materialIcon: 'link',
                onClick: onPairHostClick,
                className:
                  'text-md-outline hover:text-md-on-surface hover:bg-md-surface-container',
              },
            ]
          : []),
      ],
    });
  }

  // "Projects" was the dead cloud entity (bloop shutdown, Apr 2026). The
  // section — list, loading state and Create Project button — is intentionally
  // gone: repos are the local anchor. See issue #23 for the route demolition.

  if (isSignedIn && onExportClick) {
    sections.push({
      key: 'export',
      label: 'Export',
      items: [
        {
          key: 'export-data',
          kind: 'icon-button',
          label: 'Export data',
          materialIcon: 'download',
          isActive: isExportActive,
          onClick: onExportClick,
        },
      ],
    });
  }

  function renderSectionItem(item: AppBarSectionItem): ReactNode {
    switch (item.kind) {
      case 'icon-button':
        return maybeTooltip(
          item.label,
          'right',
          isCollapsed,
          <button
            type="button"
            onClick={item.onClick}
            className={getStandardAppBarButtonClassName({
              isActive: item.isActive,
              isCollapsed,
              className: item.className,
            })}
            aria-label={item.label}
          >
            <MaterialIcon
              name={item.materialIcon}
              fill={item.isActive ? 1 : 0}
              size="base"
            />
            {!isCollapsed && (
              <span className="truncate text-body-sm">{item.label}</span>
            )}
          </button>
        );

      case 'host-button': {
        const isOffline = item.host.status === 'offline';
        return maybeTooltip(
          `${item.host.name} · ${getHostStatusLabel(item.host.status)}`,
          'right',
          isCollapsed,
          <div className={cn('relative', !isCollapsed && 'w-full')}>
            <span
              className={cn(
                'absolute z-10',
                isCollapsed
                  ? '-top-1 -right-1'
                  : 'top-1/2 -translate-y-1/2 left-2',
                'w-3.5 h-3.5 rounded-full border border-md-surface-container-low',
                getHostStatusIndicatorClass(item.host.status)
              )}
              aria-hidden="true"
            />
            <button
              type="button"
              disabled={isOffline}
              onClick={item.onClick}
              className={cn(
                getHostButtonClassName({
                  host: item.host,
                  isActive: item.isActive,
                  isCollapsed,
                }),
                !isCollapsed && 'pl-8'
              )}
              aria-label={`${item.host.name} (${getHostStatusLabel(item.host.status)})`}
            >
              {isCollapsed ? (
                getProjectInitials(item.host.name)
              ) : (
                <span className="truncate text-body-sm">{item.host.name}</span>
              )}
            </button>
          </div>
        );
      }

      case 'kanban-cta':
        return (
          <Popover>
            {maybeTooltip(
              item.label,
              'right',
              isCollapsed,
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={getStandardAppBarButtonClassName({ isCollapsed })}
                  aria-label={item.label}
                >
                  <MaterialIcon name="view_kanban" size="base" />
                  {!isCollapsed && (
                    <span className="truncate text-body-sm">{item.label}</span>
                  )}
                </button>
              </PopoverTrigger>
            )}
            <PopoverContent side="right" sideOffset={8}>
              <p className="text-title-sm font-semibold text-md-on-surface">
                {t('appBar.kanban.title')}
              </p>
              <p className="text-body-sm text-md-on-surface-variant mt-1">
                {t('appBar.kanban.description')}
              </p>
              <div className="mt-base">
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={item.onSignIn}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-body-sm font-semibold',
                      'bg-brand text-on-brand hover:bg-brand-hover cursor-pointer transition-all duration-150'
                    )}
                  >
                    {t('signIn')}
                  </button>
                </PopoverClose>
              </div>
            </PopoverContent>
          </Popover>
        );

      case 'loading':
        return (
          <div className="flex items-center justify-center w-10 h-10">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-on-surface-variant"
            />
          </div>
        );

      case 'project-list':
        return (
          <DragDropContext onDragEnd={item.onProjectsDragEnd}>
            <Droppable
              droppableId="app-bar-projects"
              direction="vertical"
              isDropDisabled={item.isSavingProjectOrder}
            >
              {(dropProvided) => (
                <div
                  ref={dropProvided.innerRef}
                  {...dropProvided.droppableProps}
                  className={cn(
                    'flex flex-col -mb-base',
                    isCollapsed ? 'items-center' : 'items-stretch'
                  )}
                >
                  {item.projects.map((project, index) => (
                    <Draggable
                      key={project.id}
                      draggableId={project.id}
                      index={index}
                      disableInteractiveElementBlocking
                      isDragDisabled={item.isSavingProjectOrder}
                    >
                      {(dragProvided, snapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          className="mb-base"
                          style={dragProvided.draggableProps.style}
                        >
                          {maybeTooltip(
                            project.name,
                            'right',
                            isCollapsed,
                            <button
                              type="button"
                              onClick={() => item.onProjectClick(project.id)}
                              className={cn(
                                appBarItemBase,
                                getAppBarItemLayoutClass(isCollapsed),
                                'cursor-grab font-semibold text-title-sm',
                                snapshot.isDragging &&
                                  'ring-1 ring-border-strong',
                                item.activeProjectId === project.id
                                  ? 'ring-1 ring-inset ring-md-outline-variant'
                                  : 'text-md-outline hover:text-md-on-surface hover:bg-md-surface-container'
                              )}
                              style={
                                item.activeProjectId === project.id
                                  ? {
                                      color: `hsl(${project.color})`,
                                      backgroundColor: `hsl(${project.color} / 0.15)`,
                                    }
                                  : undefined
                              }
                              aria-label={project.name}
                            >
                              <span
                                className={cn(
                                  'flex items-center justify-center',
                                  isCollapsed ? 'w-full' : 'w-6 shrink-0'
                                )}
                              >
                                {getProjectInitials(project.name)}
                              </span>
                              {!isCollapsed && (
                                <span className="truncate text-body-sm font-normal">
                                  {project.name}
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {dropProvided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        );
    }
  }

  const toggleLabel = isCollapsed
    ? t('appBar.expandSidebar')
    : t('appBar.collapseSidebar');

  return (
    <div
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={cn(
        'flex flex-col h-full min-h-0 overflow-y-auto py-2 px-2 gap-3',
        isCollapsed ? 'items-center' : 'items-stretch w-56',
        'bg-md-surface-container-lowest border-r border-md-outline-variant'
      )}
    >
      {sections.map((section, sectionIndex) => (
        <div
          key={section.key}
          className={cn(
            'flex flex-col gap-0.5',
            isCollapsed ? 'items-center' : 'items-stretch'
          )}
        >
          {sectionIndex > 0 && (
            <div
              className={cn(
                'h-px bg-md-outline-variant my-1',
                isCollapsed ? 'w-6' : 'w-full'
              )}
              aria-hidden
            />
          )}
          {section.items.map((item) => (
            <div
              key={item.key}
              className={
                'wrapperClassName' in item ? item.wrapperClassName : undefined
              }
            >
              {renderSectionItem(item)}
            </div>
          ))}
        </div>
      ))}

      <div
        className={cn(
          'mt-auto flex flex-col gap-1 w-full pt-2',
          isCollapsed ? 'items-center' : 'items-stretch'
        )}
      >
        {updateVersion && (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center py-1 rounded-sm',
                isCollapsed ? 'w-10 mx-auto' : 'w-full',
                'text-label uppercase tracking-wider',
                'bg-brand text-on-brand hover:bg-brand-hover',
                'transition-all duration-150 cursor-pointer'
              )}
            >
              Update
              {!isCollapsed && updateVersion ? ` v${updateVersion}` : ''}
            </button>
          </Tooltip>
        )}
        {notificationBell && (
          <div
            className={cn(
              'flex',
              isCollapsed ? 'justify-center' : 'justify-start'
            )}
          >
            {notificationBell}
          </div>
        )}
        {userPopover && (
          <div
            className={cn(
              'flex',
              isCollapsed ? 'justify-center' : 'justify-start'
            )}
          >
            {userPopover}
          </div>
        )}
        {onOpenSettings &&
          maybeTooltip(
            'Settings',
            'right',
            isCollapsed,
            <button
              type="button"
              onClick={onOpenSettings}
              className={getStandardAppBarButtonClassName({ isCollapsed })}
              aria-label="Settings"
            >
              <MaterialIcon name="settings" size="base" />
              {!isCollapsed && (
                <span className="truncate text-body-sm">Settings</span>
              )}
            </button>
          )}
        {onToggleCollapsed &&
          maybeTooltip(
            toggleLabel,
            'right',
            isCollapsed,
            <button
              type="button"
              onClick={onToggleCollapsed}
              className={getStandardAppBarButtonClassName({ isCollapsed })}
              aria-label={toggleLabel}
            >
              <MaterialIcon
                name={isCollapsed ? 'left_panel_open' : 'left_panel_close'}
                size="base"
              />
              {!isCollapsed && (
                <span className="truncate text-body-sm">{toggleLabel}</span>
              )}
            </button>
          )}
      </div>
    </div>
  );
}
