import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';
import {
  SyncErrorIndicator,
  type SyncErrorIndicatorError,
} from './SyncErrorIndicator';
import { MaterialIcon } from './MaterialIcon';

/**
 * Action item rendered in the navbar.
 * Accepts either a Phosphor icon component (legacy) or a Material Symbol name.
 */
export interface NavbarActionItem {
  type?: 'action';
  id: string;
  /** @deprecated Prefer materialIcon */
  icon?: Icon;
  /** Material Symbols Outlined icon name — preferred over icon */
  materialIcon?: string;
  isActive?: boolean;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * Divider item rendered in the navbar.
 */
export interface NavbarDividerItem {
  type: 'divider';
}

export type NavbarSectionItem = NavbarActionItem | NavbarDividerItem;

function isDivider(item: NavbarSectionItem): item is NavbarDividerItem {
  return item.type === 'divider';
}

interface NavbarIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: Icon;
  materialIcon?: string;
  isActive?: boolean;
  tooltip?: string;
  shortcut?: string;
}

function NavbarIconButton({
  icon: IconComponent,
  materialIcon,
  isActive = false,
  tooltip,
  shortcut,
  className,
  ...props
}: NavbarIconButtonProps) {
  const button = (
    <button
      type="button"
      className={cn(
        'flex items-center justify-center p-1.5 rounded-md transition-all duration-150',
        'text-md-on-surface-variant hover:bg-md-surface-container hover:text-md-on-surface',
        isActive && 'bg-brand/10 text-brand-on-surface',
        'active:scale-95',
        className
      )}
      {...props}
    >
      {materialIcon ? (
        <MaterialIcon name={materialIcon} fill={isActive ? 1 : 0} size="base" />
      ) : IconComponent ? (
        <IconComponent
          className="size-icon-base"
          weight={isActive ? 'fill' : 'regular'}
        />
      ) : null}
    </button>
  );

  return tooltip ? (
    <Tooltip content={tooltip} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export type MobileTabId =
  | 'workspaces'
  | 'chat'
  | 'changes'
  | 'logs'
  | 'preview'
  | 'git';

export const MOBILE_TABS: {
  id: MobileTabId;
  icon?: Icon;
  materialIcon?: string;
  label: string;
}[] = [
  { id: 'workspaces', materialIcon: 'grid_view', label: 'Wksps' },
  { id: 'chat', materialIcon: 'chat', label: 'Chat' },
  { id: 'changes', materialIcon: 'difference', label: 'Diff' },
  { id: 'logs', materialIcon: 'terminal', label: 'Logs' },
  { id: 'preview', materialIcon: 'monitor', label: 'Preview' },
  { id: 'git', materialIcon: 'fork_right', label: 'Git' },
];

export interface NavbarBreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface NavbarBreadcrumbsProps {
  breadcrumbs: NavbarBreadcrumbItem[];
  textClassName: string;
}

function NavbarBreadcrumbs({
  breadcrumbs,
  textClassName,
}: NavbarBreadcrumbsProps) {
  return (
    <div className={cn('flex items-center gap-1 min-w-0', textClassName)}>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <span key={index} className="flex items-center gap-1 min-w-0">
            {index > 0 && <span className="text-md-outline shrink-0">/</span>}
            {crumb.onClick && !isLast ? (
              <button
                type="button"
                className="text-md-outline hover:text-md-on-surface-variant truncate cursor-pointer"
                onClick={crumb.onClick}
              >
                {crumb.label}
              </button>
            ) : (
              <span
                className={cn(
                  'truncate',
                  isLast ? 'text-md-on-surface-variant' : 'text-md-outline'
                )}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export interface NavbarProps {
  workspaceTitle?: string;
  breadcrumbs?: NavbarBreadcrumbItem[];
  leftItems?: NavbarSectionItem[];
  rightItems?: NavbarSectionItem[];
  leftSlot?: ReactNode;
  syncErrors?: readonly SyncErrorIndicatorError[] | null;
  className?: string;
  mobileMode?: boolean;
  mobileUserSlot?: ReactNode;
  isOnProjectPage?: boolean;
  onOpenCommandBar?: () => void;
  onOpenSettings?: () => void;
  onNavigateToBoard?: (() => void) | null;
  onNavigateBack?: () => void;
  onReload?: () => void;
  onOpenDrawer?: () => void;
  isOnProjectSubRoute?: boolean;
  mobileActiveTab?: MobileTabId;
  onMobileTabChange?: (tab: MobileTabId) => void;
  mobileTabs?: {
    id: MobileTabId;
    icon?: Icon;
    materialIcon?: string;
    label: string;
  }[];
  showMobileTabs?: boolean;
  mobileShowBack?: boolean;
}

export function Navbar({
  workspaceTitle,
  breadcrumbs,
  leftItems = [],
  rightItems = [],
  leftSlot,
  syncErrors,
  className,
  mobileMode = false,
  mobileUserSlot,
  isOnProjectPage = false,
  onOpenCommandBar,
  onOpenSettings,
  onNavigateToBoard,
  onNavigateBack,
  onReload,
  onOpenDrawer,
  isOnProjectSubRoute = false,
  mobileActiveTab = 'chat',
  onMobileTabChange,
  mobileTabs,
  showMobileTabs,
  mobileShowBack,
}: NavbarProps) {
  const renderItem = (item: NavbarSectionItem, key: string) => {
    if (isDivider(item)) {
      return <div key={key} className="h-4 w-px bg-md-outline-variant" />;
    }

    const isDisabled = !!item.disabled;

    return (
      <NavbarIconButton
        key={key}
        icon={item.icon}
        materialIcon={item.materialIcon}
        isActive={item.isActive}
        onClick={item.onClick}
        aria-label={item.tooltip}
        tooltip={item.tooltip}
        shortcut={item.shortcut}
        disabled={isDisabled}
        className={isDisabled ? 'opacity-40 cursor-not-allowed' : ''}
      />
    );
  };

  // ---- Mobile layout ----
  if (mobileMode) {
    return (
      <nav
        className={cn(
          'flex flex-col bg-md-surface-container-lowest border-b border-md-outline-variant shrink-0',
          className
        )}
      >
        <div className="flex items-center justify-between px-base py-half">
          {isOnProjectPage ? (
            <div className="flex items-center gap-base">
              {isOnProjectSubRoute
                ? onNavigateBack && (
                    <button
                      type="button"
                      className="flex items-center justify-center text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                      onClick={onNavigateBack}
                      aria-label="Back"
                    >
                      <MaterialIcon name="chevron_left" size="base" />
                    </button>
                  )
                : onOpenDrawer && (
                    <button
                      type="button"
                      className="flex items-center justify-center text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                      onClick={onOpenDrawer}
                      aria-label="Open menu"
                    >
                      <MaterialIcon name="menu_open" size="base" />
                    </button>
                  )}
              <p className="text-body-md text-md-on-surface font-semibold truncate cursor-default select-none">
                {workspaceTitle}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 overflow-x-auto">
              {mobileShowBack && onNavigateBack ? (
                <>
                  <button
                    type="button"
                    className="flex items-center justify-center px-1.5 py-1 text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                    onClick={onNavigateBack}
                    aria-label="Back"
                  >
                    <MaterialIcon name="chevron_left" size="sm" />
                  </button>
                  <div className="h-4 w-px bg-md-outline-variant mx-0.5 shrink-0" />
                </>
              ) : (
                onOpenDrawer && (
                  <>
                    <button
                      type="button"
                      className="flex items-center justify-center px-1.5 py-1 text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                      onClick={onOpenDrawer}
                      aria-label="Projects"
                    >
                      <MaterialIcon name="view_kanban" size="sm" />
                    </button>
                    <div className="h-4 w-px bg-md-outline-variant mx-0.5 shrink-0" />
                  </>
                )
              )}
              {showMobileTabs !== false &&
                (mobileTabs ?? MOBILE_TABS).map((tab) => {
                  const isActive = mobileActiveTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={cn(
                        'flex items-center gap-1 px-2 py-1 min-h-11 text-xs whitespace-nowrap transition-all duration-150 active:scale-95',
                        isActive
                          ? 'text-md-primary border-b-2 border-md-primary font-semibold'
                          : 'text-md-on-surface-variant hover:text-md-on-surface'
                      )}
                      onClick={() => onMobileTabChange?.(tab.id)}
                    >
                      {tab.materialIcon ? (
                        <MaterialIcon
                          name={tab.materialIcon}
                          fill={isActive ? 1 : 0}
                          size="sm"
                        />
                      ) : tab.icon ? (
                        <tab.icon
                          className="size-icon-sm"
                          weight={isActive ? 'fill' : 'regular'}
                        />
                      ) : null}
                      <span className="hidden min-[480px]:inline">
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              {onNavigateToBoard && (
                <button
                  type="button"
                  className="flex items-center gap-1 px-1.5 py-1 text-xs text-md-on-surface-variant hover:text-md-on-surface whitespace-nowrap active:scale-95 transition-all duration-200"
                  onClick={onNavigateToBoard}
                >
                  <MaterialIcon name="view_kanban" size="sm" />
                  <span className="hidden min-[480px]:inline">Board</span>
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-1 shrink-0">
            <SyncErrorIndicator errors={syncErrors} />
            {isOnProjectPage &&
              rightItems
                .filter((item): item is NavbarActionItem => !isDivider(item))
                .map((item) => (
                  <NavbarIconButton
                    key={item.id}
                    icon={item.icon}
                    materialIcon={item.materialIcon}
                    isActive={item.isActive}
                    onClick={item.onClick}
                    aria-label={item.tooltip}
                    tooltip={item.tooltip}
                    disabled={!!item.disabled}
                    className={
                      item.disabled ? 'opacity-40 cursor-not-allowed' : ''
                    }
                  />
                ))}
            {onReload && (
              <button
                type="button"
                className="flex items-center justify-center text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                onClick={onReload}
                aria-label="Reload"
              >
                <MaterialIcon name="refresh" size="sm" />
              </button>
            )}
            {!isOnProjectPage && onOpenSettings && (
              <button
                type="button"
                className="flex items-center justify-center text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                onClick={onOpenSettings}
                aria-label="Settings"
              >
                <MaterialIcon name="settings" size="sm" />
              </button>
            )}
            {!isOnProjectPage && onOpenCommandBar && (
              <button
                type="button"
                className="flex items-center justify-center text-md-on-surface-variant hover:text-md-on-surface active:scale-95 transition-all duration-200"
                onClick={onOpenCommandBar}
                aria-label="Command bar"
              >
                <MaterialIcon name="menu" size="sm" />
              </button>
            )}
            {mobileUserSlot && (
              <div className="h-4 w-px bg-md-outline-variant mx-0.5 shrink-0" />
            )}
            {mobileUserSlot}
          </div>
        </div>

        {!isOnProjectPage && (workspaceTitle || breadcrumbs) && (
          <div className="flex items-center justify-between px-base py-half border-t border-md-outline-variant">
            <div className="flex items-center gap-base flex-1 min-w-0">
              {leftSlot}
              {breadcrumbs && breadcrumbs.length > 0 ? (
                <NavbarBreadcrumbs
                  breadcrumbs={breadcrumbs}
                  textClassName="text-body-sm"
                />
              ) : (
                <p className="text-body-sm text-md-outline truncate cursor-default select-none">
                  {workspaceTitle}
                </p>
              )}
            </div>
          </div>
        )}
      </nav>
    );
  }

  // ---- Desktop layout ----
  return (
    <nav
      data-tauri-drag-region
      className={cn(
        'flex items-center justify-between px-3 py-1',
        'bg-md-surface-container-lowest border-b border-md-outline-variant shrink-0 h-9',
        className
      )}
    >
      <div data-tauri-drag-region className="flex-1 flex items-center gap-base">
        {leftItems.map((item, index) =>
          renderItem(
            item,
            `left-${isDivider(item) ? 'divider' : item.id}-${index}`
          )
        )}
        {leftSlot}
      </div>

      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-center min-w-0"
      >
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <NavbarBreadcrumbs
            breadcrumbs={breadcrumbs}
            textClassName="text-body-sm"
          />
        ) : (
          <p
            data-tauri-drag-region
            className="text-body-sm text-md-outline truncate cursor-default select-none"
          >
            {workspaceTitle ?? ''}
          </p>
        )}
      </div>

      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-end gap-base"
      >
        <SyncErrorIndicator errors={syncErrors} />
        {rightItems.map((item, index) =>
          renderItem(
            item,
            `right-${isDivider(item) ? 'divider' : item.id}-${index}`
          )
        )}
      </div>
    </nav>
  );
}
