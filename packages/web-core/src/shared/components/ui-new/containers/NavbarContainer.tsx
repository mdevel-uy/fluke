import { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeft, PanelBottom, PanelRight, Sparkles } from 'lucide-react';
import { useAdhocPanelStore } from '@/features/adhoc-session';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useActions } from '@/shared/hooks/useActions';
import { useSyncErrorContext } from '@/shared/hooks/useSyncErrorContext';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import {
  Navbar,
  type NavbarSectionItem,
  type NavbarBreadcrumbItem,
  type MobileTabId,
} from '@vibe/ui/components/Navbar';
import { NavbarRepoSelectorContainer } from './NavbarRepoSelectorContainer';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { NavbarActionGroups } from '@/shared/actions';
import {
  NavbarDivider,
  type ActionDefinition,
  type NavbarItem as ActionNavbarItem,
  type ActionVisibilityContext,
  isSpecialIcon,
  getActionIcon,
  getActionTooltip,
  isActionActive,
  isActionEnabled,
  isActionVisible,
} from '@/shared/types/actions';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import {
  useMobileActiveTab,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { getRemoteAuthDegradedMessage } from '@/shared/lib/auth/remoteAuthDegraded';

/**
 * Check if a NavbarItem is a divider
 */
function isDivider(item: ActionNavbarItem): item is typeof NavbarDivider {
  return 'type' in item && item.type === 'divider';
}

/**
 * Filter navbar items by visibility, keeping dividers but removing them
 * if they would appear at the start, end, or consecutively.
 */
function filterNavbarItems(
  items: readonly ActionNavbarItem[],
  ctx: ActionVisibilityContext
): ActionNavbarItem[] {
  // Filter actions by visibility, keep dividers
  const filtered = items.filter((item) => {
    if (isDivider(item)) return true;
    if (!isActionVisible(item, ctx)) return false;
    return !isSpecialIcon(getActionIcon(item, ctx));
  });

  // Remove leading/trailing dividers and consecutive dividers
  const result: ActionNavbarItem[] = [];
  for (const item of filtered) {
    if (isDivider(item)) {
      // Only add divider if we have items before it and last item wasn't a divider
      if (result.length > 0 && !isDivider(result[result.length - 1])) {
        result.push(item);
      }
    } else {
      result.push(item);
    }
  }

  // Remove trailing divider
  if (result.length > 0 && isDivider(result[result.length - 1])) {
    result.pop();
  }

  return result;
}

function toNavbarSectionItems(
  items: readonly ActionNavbarItem[],
  ctx: ActionVisibilityContext,
  onExecuteAction: (action: ActionDefinition) => void
): NavbarSectionItem[] {
  return items.reduce<NavbarSectionItem[]>((result, item) => {
    if (isDivider(item)) {
      result.push({ type: 'divider' });
      return result;
    }

    const icon = getActionIcon(item, ctx);
    if (isSpecialIcon(icon)) {
      return result;
    }

    result.push({
      type: 'action',
      id: item.id,
      icon,
      isActive: isActionActive(item, ctx),
      tooltip: getActionTooltip(item, ctx),
      shortcut: item.shortcut,
      disabled: !isActionEnabled(item, ctx),
      onClick: () => onExecuteAction(item),
    });
    return result;
  }, []);
}

export function NavbarContainer({
  mobileMode = false,
  onOpenDrawer,
  className,
}: {
  mobileMode?: boolean;
  onOpenDrawer?: () => void;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const { executeAction } = useActions();
  const { workspace: selectedWorkspace } = useWorkspaceContext();
  const syncErrorContext = useSyncErrorContext();
  const { remoteAuthDegraded } = useUserSystem();
  const appNavigation = useAppNavigation();
  const destination = useCurrentAppDestination();
  const [mobileActiveTab, setMobileActiveTab] = useMobileActiveTab();

  // Get action visibility context (includes all state for visibility/active/enabled)
  const actionCtx = useActionVisibilityContext();

  // Action handler - all actions go through the standard executeAction
  const handleExecuteAction = useCallback(
    (action: ActionDefinition) => {
      if (action.requiresTarget && selectedWorkspace?.id) {
        executeAction(action, selectedWorkspace.id);
      } else {
        executeAction(action);
      }
    },
    [executeAction, selectedWorkspace?.id]
  );

  const leftItems = useMemo(
    () =>
      toNavbarSectionItems(
        filterNavbarItems(NavbarActionGroups.left, actionCtx),
        actionCtx,
        handleExecuteAction
      ),
    [actionCtx, handleExecuteAction]
  );

  // Layout toggles (sidebar / terminal / aside), VSCode-style — SHELL-SPEC R3
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const toggleLeftSidebar = useUiPreferencesStore((s) => s.toggleLeftSidebar);
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);
  const toggleTerminal = useUiPreferencesStore((s) => s.toggleTerminal);
  const isRightSidebarVisible = useUiPreferencesStore(
    (s) => s.isRightSidebarVisible
  );
  const toggleRightSidebar = useUiPreferencesStore((s) => s.toggleRightSidebar);
  const isAdhocPanelOpen = useAdhocPanelStore((s) => s.isOpen);
  const toggleAdhocPanel = useAdhocPanelStore((s) => s.toggle);

  const layoutToggleItems: NavbarSectionItem[] = useMemo(
    () => [
      {
        type: 'action',
        id: 'toggle-adhoc-claude',
        lucideIcon: Sparkles,
        isActive: isAdhocPanelOpen,
        tooltip: t('navbar.layout.toggleAdhocClaude', {
          defaultValue: 'Ad-hoc Claude',
        }),
        onClick: toggleAdhocPanel,
      },
      {
        type: 'action',
        id: 'toggle-left-sidebar',
        lucideIcon: PanelLeft,
        isActive: isLeftSidebarVisible,
        tooltip: t('navbar.layout.toggleSidebar', {
          defaultValue: 'Toggle sidebar',
        }),
        onClick: toggleLeftSidebar,
      },
      {
        type: 'action',
        id: 'toggle-terminal',
        lucideIcon: PanelBottom,
        isActive: isTerminalVisible,
        tooltip: t('navbar.layout.toggleTerminal', {
          defaultValue: 'Toggle terminal',
        }),
        onClick: toggleTerminal,
      },
      {
        type: 'action',
        id: 'toggle-right-sidebar',
        lucideIcon: PanelRight,
        isActive: isRightSidebarVisible,
        tooltip: t('navbar.layout.toggleRightPanel', {
          defaultValue: 'Toggle right panel',
        }),
        onClick: toggleRightSidebar,
      },
    ],
    [
      t,
      isLeftSidebarVisible,
      toggleLeftSidebar,
      isTerminalVisible,
      toggleTerminal,
      isRightSidebarVisible,
      toggleRightSidebar,
      isAdhocPanelOpen,
      toggleAdhocPanel,
    ]
  );

  // SHELL-SPEC R3: the shell navbar keeps only layout toggles. Theme moved
  // to Settings only (decisión Dani 29-jul); Diff/Changes/Logs toggles stay
  // reachable via command bar, shortcuts and the context bar.
  const rightItems = useMemo(() => [...layoutToggleItems], [layoutToggleItems]);

  const navbarTitle = selectedWorkspace?.branch;

  // SHELL-SPEC R2 fallback: `proyecto › sección › workspace` (mock crumbs).
  const { repos: navRepos } = useRepos();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const activeRepo = useMemo(
    () => navRepos.find((r) => r.id === selectedRepoId) ?? navRepos[0] ?? null,
    [navRepos, selectedRepoId]
  );

  const localBreadcrumbs = useMemo((): NavbarBreadcrumbItem[] | undefined => {
    const kind = destination?.kind ?? null;
    const section: { label: string; goTo: () => void } | null =
      kind === 'workspaces' ||
      kind === 'workspace' ||
      kind === 'workspace-vscode'
        ? {
            label: t('appBar.workspaces', { defaultValue: 'Workspaces' }),
            goTo: () => appNavigation.goToWorkspaces(),
          }
        : kind === 'sprint'
          ? {
              label: t('appBar.kanban', { defaultValue: 'Kanban' }),
              goTo: () => appNavigation.goToSprint(),
            }
          : kind === 'issues'
            ? {
                label: t('appBar.issues', { defaultValue: 'Issues' }),
                goTo: () => appNavigation.goToIssues(),
              }
            : kind === 'workers'
              ? {
                  label: t('appBar.workers', { defaultValue: 'Workers' }),
                  goTo: () => appNavigation.goToWorkers(),
                }
              : kind === 'dashboard'
                ? {
                    label: t('appBar.dashboard', { defaultValue: 'Dashboard' }),
                    goTo: () => appNavigation.goToDashboard(),
                  }
                : kind === 'analyst-desk'
                  ? {
                      label: t('appBar.analystDesk', {
                        defaultValue: 'Analyst Desk',
                      }),
                      goTo: () => appNavigation.goToAnalystDesk(),
                    }
                  : null;
    if (!section) return undefined;

    const items: NavbarBreadcrumbItem[] = [];
    if (activeRepo) {
      items.push({ label: activeRepo.display_name || activeRepo.name });
    }
    const workspaceLabel =
      selectedWorkspace?.name || selectedWorkspace?.branch || '';
    if (workspaceLabel) {
      items.push({ label: section.label, onClick: section.goTo });
      items.push({ label: workspaceLabel });
    } else {
      items.push({ label: section.label });
    }
    return items;
  }, [
    destination?.kind,
    activeRepo,
    selectedWorkspace?.name,
    selectedWorkspace?.branch,
    appNavigation,
    t,
  ]);

  // Mobile-specific callbacks
  const handleOpenCommandBar = useCallback(() => {
    CommandBarDialog.show();
  }, []);

  const handleNavigateBack = useCallback(() => {
    appNavigation.goToWorkspaces();
  }, [appNavigation]);

  const syncErrors = useMemo(() => {
    const errors = syncErrorContext?.errors ? [...syncErrorContext.errors] : [];

    if (remoteAuthDegraded) {
      errors.push({
        streamId: 'remote-auth-degraded',
        tableName: 'Remote authentication',
        error: {
          message: getRemoteAuthDegradedMessage(remoteAuthDegraded, t),
        },
        retry: () => window.location.reload(),
      });
    }

    return errors;
  }, [remoteAuthDegraded, syncErrorContext?.errors, t]);

  return (
    <Navbar
      className={className}
      workspaceTitle={navbarTitle}
      breadcrumbs={localBreadcrumbs}
      leftItems={leftItems}
      rightItems={rightItems}
      syncErrors={syncErrors}
      mobileMode={mobileMode}
      onOpenCommandBar={handleOpenCommandBar}
      onNavigateBack={handleNavigateBack}
      onOpenDrawer={onOpenDrawer}
      mobileActiveTab={mobileActiveTab as MobileTabId}
      onMobileTabChange={(tab) => setMobileActiveTab(tab)}
      leftSlot={mobileMode ? <NavbarRepoSelectorContainer /> : null}
      rightSlot={null}
    />
  );
}
