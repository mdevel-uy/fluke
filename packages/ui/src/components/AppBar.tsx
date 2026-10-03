import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';
import { MaterialIcon } from './MaterialIcon';
import { useTranslation } from 'react-i18next';
import {
  Boxes,
  FileCode,
  Kanban,
  LayoutGrid,
  ListChecks,
  Brain,
  Search,
  Settings as SettingsIcon,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

function getHostInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface AppBarProps {
  hosts?: AppBarHost[];
  onPairHostClick?: () => void;
  activeHostId?: string | null;
  onExportClick?: () => void;
  onWorkspacesClick: () => void;
  onEditorClick?: () => void;
  onSearchClick?: () => void;
  onDashboardClick?: () => void;
  onSprintClick?: () => void;
  onFlukeClick?: () => void;
  onIssuesClick?: () => void;
  onWorkersClick?: () => void;
  onCiPipelinesClick?: () => void;
  onHostClick?: (hostId: string, status: AppBarHostStatus) => void;
  showWorkspacesButton?: boolean;
  showEditorButton?: boolean;
  showSearchButton?: boolean;
  showDashboardButton?: boolean;
  showSprintButton?: boolean;
  showFlukeButton?: boolean;
  showIssuesButton?: boolean;
  showWorkersButton?: boolean;
  showCiPipelinesButton?: boolean;
  isWorkspacesActive: boolean;
  isEditorActive?: boolean;
  isSearchActive?: boolean;
  /** Nº of fleet branches stopped on conflicts (SHELL-SPEC R34 badge). */
  isDashboardActive?: boolean;
  isSprintActive?: boolean;
  isFlukeActive?: boolean;
  isIssuesActive?: boolean;
  isWorkersActive?: boolean;
  isCiPipelinesActive?: boolean;
  isExportActive?: boolean;
  isSignedIn?: boolean;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  notificationBell?: ReactNode;
  userPopover?: ReactNode;
  updateVersion?: string | null;
  onUpdateClick?: () => void;
  onOpenSettings?: () => void;
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

// SHELL-SPEC R5: the rail is icons-only — 40px items, tooltip on the right.
const appBarItemBase =
  'relative flex items-center justify-center w-10 h-10 rounded-sm text-sm font-normal transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand';

type AppBarSection = {
  key: 'local' | 'remote' | 'export';
  items: AppBarSectionItem[];
};

type AppBarSectionItem =
  | {
      key: string;
      kind: 'icon-button';
      label: string;
      /** Legacy icon set — prefer lucideIcon (SHELL-SPEC R32) */
      materialIcon?: string;
      lucideIcon?: LucideIcon;
      isActive?: boolean;
      /** Numeric badge on the icon's corner (0/undefined hides it). */
      badgeCount?: number;
      onClick?: () => void;
      className?: string;
    }
  | {
      key: string;
      kind: 'host-button';
      host: AppBarHost;
      isActive: boolean;
      onClick?: () => void;
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
      ? 'relative text-md-on-surface before:absolute before:-left-1 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-brand-on-surface'
      : // VSCode: inactive rail icons are a mid-dark gray, not faint
        'text-md-on-surface-variant hover:text-md-on-surface',
    className
  );
}

function getHostButtonClassName(host: AppBarHost, isActive: boolean) {
  const isOffline = host.status === 'offline';
  return cn(
    appBarItemBase,
    isOffline
      ? 'text-md-outline opacity-50 cursor-not-allowed'
      : isActive
        ? 'relative bg-md-surface-container-high text-md-on-surface cursor-pointer before:absolute before:-left-1 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-brand-on-surface'
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
  onEditorClick,
  onSearchClick,
  onDashboardClick,
  onSprintClick,
  onFlukeClick,
  onIssuesClick,
  onWorkersClick,
  onCiPipelinesClick,
  onHostClick,
  showWorkspacesButton = true,
  showEditorButton = true,
  showSearchButton = true,
  showDashboardButton = true,
  showSprintButton = true,
  showFlukeButton = true,
  showIssuesButton = true,
  showWorkersButton = true,
  showCiPipelinesButton = true,
  isWorkspacesActive,
  isEditorActive = false,
  isSearchActive = false,
  isDashboardActive = false,
  isSprintActive = false,
  isFlukeActive = false,
  isIssuesActive = false,
  isWorkersActive = false,
  isCiPipelinesActive = false,
  isExportActive = false,
  isSignedIn,
  onHoverStart,
  onHoverEnd,
  notificationBell,
  userPopover,
  updateVersion,
  onUpdateClick,
  onOpenSettings,
}: AppBarProps) {
  const { t } = useTranslation('common');
  const sections: AppBarSection[] = [];

  if (
    showFlukeButton ||
    showWorkspacesButton ||
    showDashboardButton ||
    showSprintButton ||
    showIssuesButton ||
    showWorkersButton ||
    showCiPipelinesButton
  ) {
    const localItems: AppBarSectionItem[] = [];
    // Every request enters through Fluke (fluke v2, #701): first in the rail.
    if (showFlukeButton && onFlukeClick) {
      localItems.push({
        key: 'local-fluke',
        kind: 'icon-button',
        label: t('director.name'),
        lucideIcon: Brain,
        isActive: isFlukeActive,
        onClick: onFlukeClick,
      });
    }
    if (showDashboardButton && onDashboardClick) {
      localItems.push({
        key: 'local-dashboard',
        kind: 'icon-button',
        label: t('appBar.dashboard'),
        lucideIcon: LayoutGrid,
        isActive: isDashboardActive,
        onClick: onDashboardClick,
      });
    }
    if (showWorkspacesButton) {
      localItems.push({
        key: 'local-workspaces',
        kind: 'icon-button',
        label: t('appBar.workspaces'),
        // Distinct from Dashboard's LayoutGrid — both were near-identical
        // rectangle grids (decisión Dani 29-jul).
        lucideIcon: Boxes,
        isActive: isWorkspacesActive,
        onClick: onWorkspacesClick,
      });
    }
    if (showEditorButton && onEditorClick) {
      localItems.push({
        key: 'local-editor',
        kind: 'icon-button',
        label: t('appBar.editor', { defaultValue: 'Editor' }),
        lucideIcon: FileCode,
        isActive: isEditorActive,
        onClick: onEditorClick,
      });
    }
    if (showSprintButton && onSprintClick) {
      localItems.push({
        key: 'local-sprint',
        kind: 'icon-button',
        label: t('appBar.sprint'),
        lucideIcon: Kanban,
        isActive: isSprintActive,
        onClick: onSprintClick,
      });
    }
    if (showIssuesButton && onIssuesClick) {
      localItems.push({
        key: 'local-issues',
        kind: 'icon-button',
        label: t('appBar.issues'),
        lucideIcon: ListChecks,
        isActive: isIssuesActive,
        onClick: onIssuesClick,
      });
    }
    if (showWorkersButton && onWorkersClick) {
      localItems.push({
        key: 'local-workers',
        kind: 'icon-button',
        label: t('appBar.workers'),
        lucideIcon: Users,
        isActive: isWorkersActive,
        onClick: onWorkersClick,
      });
    }
    if (showCiPipelinesButton && onCiPipelinesClick) {
      localItems.push({
        key: 'local-ci-pipelines',
        kind: 'icon-button',
        label: t('appBar.ciPipelines', { defaultValue: 'CI Pipelines' }),
        lucideIcon: Workflow,
        isActive: isCiPipelinesActive,
        onClick: onCiPipelinesClick,
      });
    }
    if (localItems.length > 0) {
      sections.push({ key: 'local', items: localItems });
    }
  }

  if (hosts.length > 0 || onPairHostClick) {
    sections.push({
      key: 'remote',
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
              {item.lucideIcon ? (
                <item.lucideIcon size={22} strokeWidth={1.5} />
              ) : (
                <MaterialIcon
                  name={item.materialIcon ?? ''}
                  fill={item.isActive ? 1 : 0}
                  size="base"
                />
              )}
              {(item.badgeCount ?? 0) > 0 && (
                <span
                  className={cn(
                    'absolute right-1 top-1 flex h-[14px] min-w-[14px] items-center justify-center',
                    'rounded-full bg-error px-[3px] text-[9px] font-semibold leading-none text-white'
                  )}
                  aria-label={`${item.badgeCount}`}
                >
                  {item.badgeCount}
                </span>
              )}
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
                  'absolute z-10 -top-1 -right-1',
                  'w-3.5 h-3.5 rounded-full border border-md-surface-container-low',
                  getHostStatusIndicatorClass(item.host.status)
                )}
                aria-hidden="true"
              />
              <button
                type="button"
                disabled={isOffline}
                onClick={item.onClick}
                className={getHostButtonClassName(item.host, item.isActive)}
                aria-label={`${item.host.name} (${getHostStatusLabel(item.host.status)})`}
              >
                {getHostInitials(item.host.name)}
              </button>
            </div>
          </Tooltip>
        );
      }
    }
  }

  return (
    <div
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={cn(
        'flex flex-col items-center h-full min-h-0 overflow-y-auto py-2 px-1 gap-3',
        'bg-md-surface-container-low border-r border-md-outline-variant'
      )}
    >
      {sections.map((section, sectionIndex) => (
        <div key={section.key} className="flex flex-col items-center gap-0.5">
          {sectionIndex > 0 && (
            <div className="h-px bg-md-outline-variant my-1 w-6" aria-hidden />
          )}
          {section.items.map((item) => (
            <div key={item.key}>{renderSectionItem(item)}</div>
          ))}
        </div>
      ))}

      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        {updateVersion && (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center py-1 rounded-sm w-10',
                'text-label uppercase tracking-wider',
                'bg-brand text-on-brand hover:bg-brand-hover',
                'transition-all duration-150 cursor-pointer'
              )}
            >
              Update
            </button>
          </Tooltip>
        )}
        {notificationBell && (
          <div className="flex justify-center">{notificationBell}</div>
        )}
        {userPopover && (
          <div className="flex justify-center">{userPopover}</div>
        )}
        {showSearchButton && onSearchClick && (
          <Tooltip
            content={t('appBar.search', { defaultValue: 'Search' })}
            side="right"
          >
            <button
              type="button"
              onClick={onSearchClick}
              className={getStandardAppBarButtonClassName({
                isActive: isSearchActive,
              })}
              aria-label={t('appBar.search', { defaultValue: 'Search' })}
            >
              <Search size={22} strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}
        {onOpenSettings && (
          <Tooltip content={t('appBar.settings')} side="right">
            <button
              type="button"
              onClick={onOpenSettings}
              className={getStandardAppBarButtonClassName({})}
              aria-label={t('appBar.settings')}
            >
              <SettingsIcon size={22} strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
