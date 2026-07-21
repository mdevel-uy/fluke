import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DropResult } from '@hello-pangea/dnd';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { X, Layout, Users, AlertCircle, Zap } from 'lucide-react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';
import { isTauriMac } from '@/shared/lib/platform';

import { NavbarContainer } from './NavbarContainer';
import { StatusBarContainer } from './StatusBarContainer';
import { AppBar } from '@vibe/ui/components/AppBar';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppUpdateStore } from '@/shared/stores/useAppUpdateStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  getProjectDestination,
  isIssuesDestination,
  isLocalWorkspacesDestination,
  isSprintDestination,
  isWorkersDestination,
} from '@/shared/lib/routes/appNavigation';
import { useTranslation } from 'react-i18next';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';
import { useWorkspaceSidebarPreviewController } from '@/shared/hooks/useWorkspaceSidebarPreviewController';
import { useShape } from '@/shared/integrations/electric/hooks';
import { sortProjectsByOrder } from '@/shared/lib/projectOrder';
import {
  PROJECT_MUTATION,
  PROJECTS_SHAPE,
  type Project as RemoteProject,
} from 'shared/remote-types';
import { WorkspacesSidebarContainer } from '@/pages/workspaces/WorkspacesSidebarContainer';
import { WorkspacesSidebarReopenTag } from '@vibe/ui/components/WorkspacesSidebar';

export function SharedAppLayout() {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const mobileFontScale = useUiPreferencesStore((s) => s.mobileFontScale);
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const { appVersion } = useUserSystem();
  const updateVersion = useAppUpdateStore((s) => s.updateVersion);
  const restartForUpdate = useAppUpdateStore((s) => s.restart);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAppBarHovered, setIsAppBarHovered] = useState(false);
  const navigate = useNavigate();

  // Register CMD+K shortcut globally for all routes under SharedAppLayout
  useCommandBarShortcut(() => CommandBarDialog.show());

  // Apply mobile font scale CSS variable
  useEffect(() => {
    if (!isMobile) {
      document.documentElement.style.removeProperty('--mobile-font-scale');
      return;
    }
    const scaleMap = { default: '1', small: '0.9', smaller: '0.8' } as const;
    document.documentElement.style.setProperty(
      '--mobile-font-scale',
      scaleMap[mobileFontScale]
    );
    return () => {
      document.documentElement.style.removeProperty('--mobile-font-scale');
    };
  }, [isMobile, mobileFontScale]);

  // AppBar state - organizations and projects
  const { data: orgsData } = useUserOrganizations();
  const organizations = useMemo(
    () => orgsData?.organizations ?? [],
    [orgsData?.organizations]
  );

  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);
  const prevOrgIdRef = useRef<string | null>(null);

  // Auto-select first org if none selected or selection is invalid
  useEffect(() => {
    if (organizations.length === 0) return;

    const hasValidSelection = selectedOrgId
      ? organizations.some((org) => org.id === selectedOrgId)
      : false;

    if (!selectedOrgId || !hasValidSelection) {
      const firstNonPersonal = organizations.find((org) => !org.is_personal);
      setSelectedOrgId((firstNonPersonal ?? organizations[0]).id);
    }
  }, [organizations, selectedOrgId, setSelectedOrgId]);

  const projectParams = useMemo(
    () => ({ organization_id: selectedOrgId || '' }),
    [selectedOrgId]
  );
  const {
    data: orgProjects = [],
    isLoading,
    updateMany: updateManyProjects,
  } = useShape(PROJECTS_SHAPE, projectParams, {
    enabled: false,
    mutation: PROJECT_MUTATION,
  });
  const sortedProjects = useMemo(
    () => sortProjectsByOrder(orgProjects),
    [orgProjects]
  );
  const [orderedProjects, setOrderedProjects] =
    useState<RemoteProject[]>(sortedProjects);
  const [isSavingProjectOrder, setIsSavingProjectOrder] = useState(false);

  useEffect(() => {
    if (isSavingProjectOrder) {
      return;
    }
    setOrderedProjects(sortedProjects);
  }, [isSavingProjectOrder, sortedProjects]);

  // Navigate to the first ordered project when org changes
  useEffect(() => {
    if (
      prevOrgIdRef.current !== null &&
      prevOrgIdRef.current !== selectedOrgId &&
      selectedOrgId &&
      !isLoading
    ) {
      if (sortedProjects.length > 0) {
        appNavigation.goToProject(sortedProjects[0].id);
      } else {
        appNavigation.goToWorkspaces();
      }
      prevOrgIdRef.current = selectedOrgId;
    } else if (prevOrgIdRef.current === null && selectedOrgId) {
      prevOrgIdRef.current = selectedOrgId;
    }
  }, [selectedOrgId, sortedProjects, isLoading, appNavigation]);

  // Navigation state for AppBar active indicators
  const projectDestination = useMemo(
    () => getProjectDestination(currentDestination),
    [currentDestination]
  );
  const isWorkspacesActive = isLocalWorkspacesDestination(currentDestination);
  const isIssuesActive = isIssuesDestination(currentDestination);
  const isWorkersActive = isWorkersDestination(currentDestination);
  const isSprintActive = isSprintDestination(currentDestination);
  const isWorkspaceSidebarPreviewEnabled =
    !isMobile && isWorkspacesActive && !isLeftSidebarVisible;
  const activeProjectId = projectDestination?.projectId ?? null;
  const sidebarPreview = useWorkspaceSidebarPreviewController({
    enabled: isWorkspaceSidebarPreviewEnabled,
    isAppBarHovered,
  });

  // Persist last selected project to scratch store
  const setSelectedProjectId = useUiPreferencesStore(
    (s) => s.setSelectedProjectId
  );
  useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
    }
  }, [activeProjectId, setSelectedProjectId]);

  const handleWorkspacesClick = useCallback(() => {
    void navigate({ to: '/workspaces' });
  }, [navigate]);

  const handleIssuesClick = useCallback(() => {
    appNavigation.goToIssues();
  }, [appNavigation]);

  const handleWorkersClick = useCallback(() => {
    appNavigation.goToWorkers();
  }, [appNavigation]);

  const handleSprintClick = useCallback(() => {
    appNavigation.goToSprint();
  }, [appNavigation]);

  const handleProjectClick = useCallback(
    (projectId: string) => {
      appNavigation.goToProject(projectId);
    },
    [appNavigation]
  );

  const handleProjectsDragEnd = useCallback(
    async ({ source, destination }: DropResult) => {
      if (isSavingProjectOrder) {
        return;
      }
      if (!destination || source.index === destination.index) {
        return;
      }

      const previousOrder = orderedProjects;
      const reordered = [...orderedProjects];
      const [moved] = reordered.splice(source.index, 1);

      if (!moved) {
        return;
      }

      reordered.splice(destination.index, 0, moved);
      setOrderedProjects(reordered);
      setIsSavingProjectOrder(true);

      try {
        await updateManyProjects(
          reordered.map((project, index) => ({
            id: project.id,
            changes: { sort_order: index },
          }))
        ).persisted;
      } catch (error) {
        console.error('Failed to reorder projects:', error);
        setOrderedProjects(previousOrder);
      } finally {
        setIsSavingProjectOrder(false);
      }
    },
    [isSavingProjectOrder, orderedProjects, updateManyProjects]
  );

  const handleCreateProject = useCallback(() => {}, []);

  return (
    <SyncErrorProvider>
      <div
        className={cn(
          'bg-primary',
          isMobile
            ? 'flex fixed inset-0 pb-[env(safe-area-inset-bottom)]'
            : 'grid grid-cols-[auto_1fr] grid-rows-[auto_1fr_auto] h-screen'
        )}
      >
        {!isMobile && (
          <>
            {/* Desktop corner spacer. */}
            <div
              data-tauri-drag-region
              className="bg-secondary/60 border-b border-r border-border/60"
              style={isTauriMac() ? { minWidth: 56 } : undefined}
            />
            {/* Desktop navbar. */}
            <NavbarContainer onOpenDrawer={() => setIsDrawerOpen(true)} />
            {/* Desktop AppBar sidebar. */}
            <AppBar
              projects={orderedProjects}
              onCreateProject={handleCreateProject}
              onWorkspacesClick={handleWorkspacesClick}
              onIssuesClick={handleIssuesClick}
              onWorkersClick={handleWorkersClick}
              onSprintClick={handleSprintClick}
              onProjectClick={handleProjectClick}
              onProjectsDragEnd={handleProjectsDragEnd}
              isSavingProjectOrder={isSavingProjectOrder}
              isWorkspacesActive={isWorkspacesActive}
              isIssuesActive={isIssuesActive}
              isWorkersActive={isWorkersActive}
              isSprintActive={isSprintActive}
              activeProjectId={activeProjectId}
              isSignedIn
              isLoadingProjects={false}
              onHoverStart={() => setIsAppBarHovered(true)}
              onHoverEnd={() => setIsAppBarHovered(false)}
              appVersion={appVersion}
              updateVersion={updateVersion}
              onUpdateClick={restartForUpdate ?? undefined}
            />
            {/* Desktop content. */}
            <div className="relative min-h-0 overflow-hidden">
              {isWorkspaceSidebarPreviewEnabled && (
                <div className="absolute inset-y-0 left-0 z-20 flex items-center">
                  <WorkspacesSidebarReopenTag
                    active={sidebarPreview.isPreviewOpen}
                    onHoverStart={sidebarPreview.handleHandleHoverStart}
                    onHoverEnd={sidebarPreview.handleHandleHoverEnd}
                    ariaLabel="Workspaces"
                  />
                </div>
              )}

              {isWorkspaceSidebarPreviewEnabled && (
                <div
                  className={cn(
                    'absolute left-0 top-0 z-30 h-full w-[300px] transition-transform duration-150 ease-out',
                    sidebarPreview.isPreviewOpen
                      ? 'translate-x-0 pointer-events-auto'
                      : '-translate-x-full pointer-events-none'
                  )}
                  onMouseEnter={sidebarPreview.handlePreviewHoverStart}
                  onMouseLeave={sidebarPreview.handlePreviewHoverEnd}
                >
                  <div className="h-full w-full overflow-hidden border-r border-border bg-secondary shadow-lg">
                    <WorkspacesSidebarContainer />
                  </div>
                </div>
              )}

              <Outlet />
            </div>
            {/* Workbench status bar (spans rail + content). */}
            <StatusBarContainer
              className="col-span-2"
              appVersion={appVersion}
              updateVersion={updateVersion}
              onUpdateClick={restartForUpdate ?? undefined}
            />
          </>
        )}

        {isMobile && (
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <NavbarContainer
              mobileMode={isMobile}
              onOpenDrawer={() => setIsDrawerOpen(true)}
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              <Outlet />
            </div>
          </div>
        )}

        {/* Mobile navigation drawer */}
        <MobileDrawer
          open={isDrawerOpen && isMobile}
          onClose={() => setIsDrawerOpen(false)}
        >
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-end p-4 border-b border-border/60">
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                className="p-1.5 rounded-md text-low hover:bg-secondary hover:text-high transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" strokeWidth={2.5} />
              </button>
            </div>

            <div className="flex flex-col gap-1 p-3">
              <button
                type="button"
                onClick={() => {
                  void navigate({ to: '/workspaces' });
                  setIsDrawerOpen(false);
                }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
              >
                <Layout className="h-4 w-4" strokeWidth={2} />
                Workspaces
              </button>

              <button
                type="button"
                onClick={() => {
                  handleIssuesClick();
                  setIsDrawerOpen(false);
                }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
              >
                <AlertCircle className="h-4 w-4" strokeWidth={2} />
                Issues
              </button>

              <button
                type="button"
                onClick={() => {
                  handleWorkersClick();
                  setIsDrawerOpen(false);
                }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
              >
                <Users className="h-4 w-4" strokeWidth={2} />
                {t('appBar.workers')}
              </button>

              <button
                type="button"
                onClick={() => {
                  handleSprintClick();
                  setIsDrawerOpen(false);
                }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
              >
                <Zap className="h-4 w-4" strokeWidth={2} />
                {t('appBar.sprint')}
              </button>
            </div>
          </div>
        </MobileDrawer>
      </div>
    </SyncErrorProvider>
  );
}
