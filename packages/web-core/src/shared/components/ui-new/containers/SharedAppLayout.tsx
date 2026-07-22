import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { X, Layout, Users, AlertCircle, Zap } from 'lucide-react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

import { NavbarContainer } from './NavbarContainer';
import { StatusBarContainer } from './StatusBarContainer';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { WorkbenchShell } from '@/workbench/WorkbenchShell';
import { WorkbenchRail } from '@/workbench/containers/WorkbenchRail';
import { WorkbenchSidebar } from '@/workbench/containers/WorkbenchSidebar';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppUpdateStore } from '@/shared/stores/useAppUpdateStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { getProjectDestination } from '@/shared/lib/routes/appNavigation';
import { useTranslation } from 'react-i18next';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';

export function SharedAppLayout() {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const mobileFontScale = useUiPreferencesStore((s) => s.mobileFontScale);
  const { appVersion } = useUserSystem();
  const updateVersion = useAppUpdateStore((s) => s.updateVersion);
  const restartForUpdate = useAppUpdateStore((s) => s.restart);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
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

  // Organizations — auto-select first org if none selected or selection invalid
  const { data: orgsData } = useUserOrganizations();
  const organizations = useMemo(
    () => orgsData?.organizations ?? [],
    [orgsData?.organizations]
  );
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);

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

  // Persist last selected project to scratch store
  const projectDestination = useMemo(
    () => getProjectDestination(currentDestination),
    [currentDestination]
  );
  const activeProjectId = projectDestination?.projectId ?? null;
  const setSelectedProjectId = useUiPreferencesStore(
    (s) => s.setSelectedProjectId
  );
  useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
    }
  }, [activeProjectId, setSelectedProjectId]);

  const handleIssuesClick = useCallback(() => {
    appNavigation.goToIssues();
  }, [appNavigation]);

  const handleWorkersClick = useCallback(() => {
    appNavigation.goToWorkers();
  }, [appNavigation]);

  const handleSprintClick = useCallback(() => {
    appNavigation.goToSprint();
  }, [appNavigation]);

  return (
    <SyncErrorProvider>
      {!isMobile ? (
        /* Desktop — Workbench shell (design/UI-SPEC.md) */
        <WorkbenchShell
          rail={<WorkbenchRail />}
          sidebar={<WorkbenchSidebar />}
          topBar={
            <NavbarContainer onOpenDrawer={() => setIsDrawerOpen(true)} />
          }
          statusBar={
            <StatusBarContainer
              appVersion={appVersion}
              updateVersion={updateVersion}
              onUpdateClick={restartForUpdate ?? undefined}
            />
          }
        >
          <Outlet />
        </WorkbenchShell>
      ) : (
        <div className="bg-primary flex fixed inset-0 pb-[env(safe-area-inset-bottom)]">
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <NavbarContainer
              mobileMode={isMobile}
              onOpenDrawer={() => setIsDrawerOpen(true)}
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              <Outlet />
            </div>
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
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-normal text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
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
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-normal text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
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
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-normal text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
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
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-normal text-normal hover:bg-secondary hover:text-high transition-colors cursor-pointer"
            >
              <Zap className="h-4 w-4" strokeWidth={2} />
              {t('appBar.sprint')}
            </button>
          </div>
        </div>
      </MobileDrawer>
    </SyncErrorProvider>
  );
}
