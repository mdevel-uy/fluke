import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Icon } from '@phosphor-icons/react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { getModifierKey } from '../lib/platform';
import { Tooltip } from './Tooltip';
import {
  SyncErrorIndicator,
  type SyncErrorIndicatorError,
} from './SyncErrorIndicator';
import { MaterialIcon } from './MaterialIcon';

const COMMAND_BAR_ACTION_ID = 'open-command-bar';

/**
 * Action item rendered in the navbar.
 * Accepts either a Phosphor icon component (legacy) or a Material Symbol name.
 */
export interface NavbarActionItem {
  type?: 'action';
  id: string;
  /** @deprecated Prefer lucideIcon */
  icon?: Icon;
  /** @deprecated Prefer lucideIcon */
  materialIcon?: string;
  /** Lucide icon component — canonical per UI-SPEC v3 */
  lucideIcon?: LucideIcon;
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
  lucideIcon?: LucideIcon;
  isActive?: boolean;
  tooltip?: string;
  shortcut?: string;
}

function NavbarIconButton({
  icon: IconComponent,
  materialIcon,
  lucideIcon: LucideIconComponent,
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
      {LucideIconComponent ? (
        <LucideIconComponent size={16} strokeWidth={1.75} />
      ) : materialIcon ? (
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

interface CommandBarTriggerProps {
  onClick: () => void;
  compact?: boolean;
  label?: string;
  className?: string;
}

function CommandBarTrigger({
  onClick,
  compact = false,
  label,
  className,
}: CommandBarTriggerProps) {
  const { t } = useTranslation('common');
  const placeholder = label ?? t('navbar.commandBarTrigger.placeholder');
  const ariaLabel = t('navbar.commandBarTrigger.ariaLabel');
  const shortcut = `${getModifierKey()}K`;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        'group flex items-center gap-1.5 rounded-full border border-md-outline-variant',
        'bg-md-surface-container-low text-md-on-surface-variant',
        'hover:bg-md-surface-container hover:text-md-on-surface hover:border-md-outline',
        'transition-colors duration-150 active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        compact
          ? 'h-6 px-2 max-w-[220px]'
          : 'h-6 px-3 w-full max-w-md min-w-[220px]',
        className
      )}
    >
      <MaterialIcon name="search" size="xs" />
      <span className="flex-1 text-left text-xs truncate">{placeholder}</span>
      <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-medium text-md-on-surface-variant/80 ml-1">
        {shortcut}
      </kbd>
    </button>
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
  { id: 'workspaces', materialIcon: 'view_quilt', label: 'Wksps' },
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
  rightSlot?: ReactNode;
  syncErrors?: readonly SyncErrorIndicatorError[] | null;
  className?: string;
  mobileMode?: boolean;
  mobileUserSlot?: ReactNode;
  isOnProjectPage?: boolean;
  onOpenCommandBar?: () => void;
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
  rightSlot,
  syncErrors,
  className,
  mobileMode = false,
  mobileUserSlot,
  isOnProjectPage = false,
  onOpenCommandBar,
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
  const stripHamburgerAction = (items: NavbarSectionItem[]) => {
    // Drop the "Open Command Bar" icon action (and stray dividers it leaves
    // behind) so it isn't duplicated alongside the persistent centered trigger.
    const withoutAction = items.filter(
      (item) => isDivider(item) || item.id !== COMMAND_BAR_ACTION_ID
    );
    const cleaned: NavbarSectionItem[] = [];
    for (const item of withoutAction) {
      if (isDivider(item)) {
        if (cleaned.length === 0) continue;
        if (isDivider(cleaned[cleaned.length - 1])) continue;
      }
      cleaned.push(item);
    }
    while (cleaned.length > 0 && isDivider(cleaned[cleaned.length - 1])) {
      cleaned.pop();
    }
    return cleaned;
  };

  const visibleLeftItems = stripHamburgerAction(leftItems);
  const visibleRightItems = stripHamburgerAction(rightItems);

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
        lucideIcon={item.lucideIcon}
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
              visibleRightItems
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
            {onOpenCommandBar && (
              <CommandBarTrigger onClick={onOpenCommandBar} compact />
            )}
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
        'flex items-stretch justify-between',
        'bg-md-surface-container-lowest border-b border-md-outline-variant shrink-0 h-9',
        className
      )}
    >
      <div data-tauri-drag-region className="flex-1 flex items-stretch min-w-0">
        <div className="flex items-center gap-base px-2 min-w-0">
          {visibleLeftItems.map((item, index) =>
            renderItem(
              item,
              `left-${isDivider(item) ? 'divider' : item.id}-${index}`
            )
          )}
          {leftSlot}
          {breadcrumbs && breadcrumbs.length > 0 ? (
            <NavbarBreadcrumbs
              breadcrumbs={breadcrumbs}
              textClassName="text-body-sm"
            />
          ) : workspaceTitle ? (
            <p
              data-tauri-drag-region
              className="text-body-sm text-md-outline truncate cursor-default select-none"
            >
              {workspaceTitle}
            </p>
          ) : null}
        </div>
      </div>

      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-center min-w-0 px-2"
      >
        {onOpenCommandBar && <CommandBarTrigger onClick={onOpenCommandBar} />}
      </div>

      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-end gap-base px-3"
      >
        <SyncErrorIndicator errors={syncErrors} />
        {rightSlot}
        {visibleRightItems.map((item, index) =>
          renderItem(
            item,
            `right-${isDivider(item) ? 'divider' : item.id}-${index}`
          )
        )}
      </div>
    </nav>
  );
}
