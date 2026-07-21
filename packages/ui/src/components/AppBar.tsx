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
  onIssuesClick?: () => void;
  onWorkersClick?: () => void;
  onSprintClick?: () => void;
  onHostClick?: (hostId: string, status: AppBarHostStatus) => void;
  showWorkspacesButton?: boolean;
  showIssuesButton?: boolean;
  showWorkersButton?: boolean;
  showSprintButton?: boolean;
  onProjectClick: (projectId: string) => void;
  onProjectsDragEnd: (result: DropResult) => void;
  isSavingProjectOrder?: boolean;
  isWorkspacesActive: boolean;
  isIssuesActive?: boolean;
  isWorkersActive?: boolean;
  isSprintActive?: boolean;
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

function AppBarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="w-10 text-center text-label-caps font-geist font-semibold uppercase tracking-widest text-md-outline">
      {children}
    </p>
  );
}

const appBarItemBase =
  'flex items-center justify-center w-10 h-10 rounded-sm text-sm font-normal transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand';

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
  className,
}: {
  isActive?: boolean;
  className?: string;
}) {
  return cn(
    appBarItemBase,
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
}: {
  host: AppBarHost;
  isActive: boolean;
}) {
  const isOffline = host.status === 'offline';
  return cn(
    appBarItemBase,
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
  projects,
  hosts = [],
  onPairHostClick,
  activeHostId = null,
  onCreateProject,
  onExportClick,
  onWorkspacesClick,
  onIssuesClick,
  onWorkersClick,
  onSprintClick,
  onHostClick,
  showWorkspacesButton = true,
  showIssuesButton = true,
  showWorkersButton = true,
  showSprintButton = true,
  onProjectClick,
  onProjectsDragEnd,
  isSavingProjectOrder,
  isWorkspacesActive,
  isIssuesActive = false,
  isWorkersActive = false,
  isSprintActive = false,
  isExportActive = false,
  activeProjectId,
  isSignedIn,
  isLoadingProjects,
  onSignIn,
  onHoverStart,
  onHoverEnd,
  notificationBell,
  userPopover,
  appVersion,
  updateVersion,
  onUpdateClick,
}: AppBarProps) {
  const { t } = useTranslation('common');
  const sections: AppBarSection[] = [];

  if (
    showWorkspacesButton ||
    showIssuesButton ||
    showWorkersButton ||
    showSprintButton
  ) {
    const localItems: AppBarSectionItem[] = [];
    if (showWorkspacesButton) {
      localItems.push({
        key: 'local-workspaces',
        kind: 'icon-button',
        label: 'Local workspaces',
        materialIcon: 'grid_view',
        isActive: isWorkspacesActive,
        onClick: onWorkspacesClick,
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
    if (showSprintButton && onSprintClick) {
      localItems.push({
        key: 'local-sprint',
        kind: 'icon-button',
        label: t('appBar.sprint'),
        materialIcon: 'bolt',
        isActive: isSprintActive,
        onClick: onSprintClick,
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

  const projectSectionItems: AppBarSectionItem[] = [];

  if (!isSignedIn) {
    projectSectionItems.push({
      key: 'kanban-cta',
      kind: 'kanban-cta',
      label: t('appBar.kanban.tooltip'),
      onSignIn,
    });
  }

  if (isLoadingProjects) {
    projectSectionItems.push({ key: 'projects-loading', kind: 'loading' });
  }

  if (projects.length > 0) {
    projectSectionItems.push({
      key: 'project-list',
      kind: 'project-list',
      projects,
      activeProjectId,
      isSavingProjectOrder,
      onProjectClick,
      onProjectsDragEnd,
    });
  }

  if (isSignedIn) {
    projectSectionItems.push({
      key: 'create-project',
      kind: 'icon-button',
      label: 'Create project',
      materialIcon: 'add',
      onClick: onCreateProject,
      className:
        'text-md-outline hover:text-md-on-surface hover:bg-md-surface-container',
      wrapperClassName: 'pt-base',
    });
  }

  if (projectSectionItems.length > 0) {
    sections.push({
      key: 'projects',
      label: 'Projects',
      items: projectSectionItems,
    });
  }

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
        return (
          <Tooltip content={item.label} side="right">
            <button
              type="button"
              onClick={item.onClick}
              className={getStandardAppBarButtonClassName({
                isActive: item.isActive,
                className: item.className,
              })}
              aria-label={item.label}
            >
              <MaterialIcon
                name={item.materialIcon}
                fill={item.isActive ? 1 : 0}
                size="base"
              />
            </button>
          </Tooltip>
        );

      case 'host-button': {
        const isOffline = item.host.status === 'offline';
        return (
          <Tooltip
            content={`${item.host.name} · ${getHostStatusLabel(item.host.status)}`}
            side="right"
          >
            <div className="relative">
              <span
                className={cn(
                  'absolute -top-1 -right-1 z-10',
                  'w-3.5 h-3.5 rounded-full border border-md-surface-container-low',
                  getHostStatusIndicatorClass(item.host.status)
                )}
                aria-hidden="true"
              />
              <button
                type="button"
                disabled={isOffline}
                onClick={item.onClick}
                className={getHostButtonClassName({
                  host: item.host,
                  isActive: item.isActive,
                })}
                aria-label={`${item.host.name} (${getHostStatusLabel(item.host.status)})`}
              >
                {getProjectInitials(item.host.name)}
              </button>
            </div>
          </Tooltip>
        );
      }

      case 'kanban-cta':
        return (
          <Popover>
            <Tooltip content={item.label} side="right">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={getStandardAppBarButtonClassName({})}
                  aria-label={item.label}
                >
                  <MaterialIcon name="view_kanban" size="base" />
                </button>
              </PopoverTrigger>
            </Tooltip>
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
                  className="flex flex-col items-center -mb-base"
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
                          <Tooltip content={project.name} side="right">
                            <button
                              type="button"
                              onClick={() => item.onProjectClick(project.id)}
                              className={cn(
                                appBarItemBase,
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
                              {getProjectInitials(project.name)}
                            </button>
                          </Tooltip>
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

  return (
    <div
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={cn(
        'flex flex-col items-center h-full min-h-0 overflow-y-auto py-2 px-2 gap-3',
        'bg-md-surface-container-lowest border-r border-md-outline-variant'
      )}
    >
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col items-center gap-1.5">
          <AppBarSectionLabel>{section.label}</AppBarSectionLabel>
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

      <div className="mt-auto pt-3 border-t border-md-outline-variant flex flex-col items-center gap-3 w-full">
        {notificationBell}
        {userPopover}
        {updateVersion ? (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center py-1 rounded-sm w-10',
                'text-label-caps font-geist font-semibold uppercase tracking-widest',
                'bg-brand text-on-brand hover:bg-brand-hover',
                'transition-all duration-150 cursor-pointer'
              )}
            >
              Update
            </button>
          </Tooltip>
        ) : (
          appVersion && (
            <p
              className="text-label-caps font-geist text-md-outline leading-none truncate max-w-10 text-center"
              title={`v${appVersion}`}
            >
              v{appVersion}
            </p>
          )
        )}
      </div>
    </div>
  );
}
