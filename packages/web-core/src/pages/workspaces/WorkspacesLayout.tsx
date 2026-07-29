import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useMobileActiveTab } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { ReviewProvider } from '@/shared/hooks/ReviewProvider';
import { ChangesViewProvider } from '@/shared/hooks/ChangesViewProvider';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { EditorSidebarContainer } from './EditorSidebarContainer';
import { WorkspaceSearchSidebarContainer } from './WorkspaceSearchSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { LogsContentContainer } from './LogsContentContainer';
import {
  WorkspacesMainContainer,
  type WorkspacesMainContainerHandle,
} from './WorkspacesMainContainer';
import { RightSidebar } from './RightSidebar';
import { EditorAside } from './EditorAside';
import { ChangesPanelContainer } from './ChangesPanelContainer';
import { EditorPanelContainer } from './EditorPanelContainer';
import { PreviewBrowserContainer } from './PreviewBrowserContainer';
import { WorkspacesGuideDialog } from '@/shared/dialogs/shared/WorkspacesGuideDialog';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useQueryClient } from '@tanstack/react-query';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { workspacesApi } from '@/shared/lib/api';

import { useWorkspaceTabGroups } from '@/shared/stores/useUiPreferencesStore';
import { WorkspaceTabGroups } from './WorkspaceTabGroups';

const WORKSPACES_GUIDE_ID = 'workspaces-guide';

export function WorkspacesLayout() {
  const appNavigation = useAppNavigation();
  const {
    workspaceId,
    workspace: selectedWorkspace,
    activeWorkspaces,
    isWorkspacesListLoading,
    isLoading,
    selectedSession,
    selectedSessionId,
    sessions,
    isSessionsLoading,
    selectSession,
    repos,
    isNewSessionMode,
    startNewSession,
  } = useWorkspaceContext();

  const { t } = useTranslation('common');
  const headerTitle = selectedWorkspace?.name ?? t('workspaces.title');
  usePageTitle(selectedWorkspace?.name);

  const header = <PageHeader title={headerTitle} />;

  const isMobile = useIsMobile();
  const [mobileTab] = useMobileActiveTab();
  const mainContainerRef = useRef<WorkspacesMainContainerHandle>(null);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      mainContainerRef.current?.scrollToBottom(behavior);
    },
    []
  );

  // VSCode-style tab groups (SHELL-SPEC R14)
  const [tabGroups, setTabGroups] = useWorkspaceTabGroups(workspaceId);

  // Stale route guard: the workspace can disappear underneath us (purged
  // from another tab / the API). Without this the explorer polls a dead id
  // forever and the editor pane renders blank. `isLoading` covers both the
  // list stream and the workspace record fetch, so archived workspaces
  // (record resolves) never trigger the redirect.
  useEffect(() => {
    if (!workspaceId || isLoading || selectedWorkspace) return;
    appNavigation.goToWorkspaces({ replace: true });
  }, [workspaceId, isLoading, selectedWorkspace, appNavigation]);

  const {
    config,
    updateAndSaveConfig,
    loading: configLoading,
  } = useUserSystem();
  const hasAutoShownWorkspacesGuide = useRef(false);

  // Auto-show Workspaces Guide on first visit
  useEffect(() => {
    if (hasAutoShownWorkspacesGuide.current) return;
    if (configLoading || !config) return;

    const seenFeatures = config.showcases?.seen_features ?? [];
    if (seenFeatures.includes(WORKSPACES_GUIDE_ID)) return;

    hasAutoShownWorkspacesGuide.current = true;

    void updateAndSaveConfig({
      showcases: { seen_features: [...seenFeatures, WORKSPACES_GUIDE_ID] },
    });
    WorkspacesGuideDialog.show().finally(() => WorkspacesGuideDialog.hide());
  }, [configLoading, config, updateAndSaveConfig]);

  // ── Mobile layout ──────────────────────────────────────────────────
  // Uses `hidden` CSS class (NOT conditional rendering) to preserve
  // WebSocket connections and scroll positions across tab switches.
  if (isMobile) {
    const mobileContent = (
      <ReviewProvider workspaceId={selectedWorkspace?.id}>
        <ChangesViewProvider>
          <div className="flex flex-col h-full min-h-0">
            {/* Workspaces tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'workspaces' && 'hidden'
              )}
            >
              <WorkspacesSidebarContainer
                onScrollToBottom={handleScrollToBottom}
              />
            </div>

            {/* Chat tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'chat' && 'hidden'
              )}
            >
              <WorkspacesMainContainer
                ref={mainContainerRef}
                selectedWorkspace={selectedWorkspace ?? null}
                selectedSession={selectedSession}
                selectedSessionId={selectedSessionId}
                sessions={sessions}
                repos={repos}
                onSelectSession={selectSession}
                isLoading={isLoading}
                isSessionsLoading={isSessionsLoading}
                isNewSessionMode={isNewSessionMode}
                onStartNewSession={startNewSession}
              />
            </div>

            {/* Changes tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'changes' && 'hidden'
              )}
            >
              {selectedWorkspace?.id && (
                <ChangesPanelContainer
                  className=""
                  workspaceId={selectedWorkspace.id}
                />
              )}
            </div>

            {/* Logs tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'logs' && 'hidden'
              )}
            >
              <LogsContentContainer className="" />
            </div>

            {/* Preview tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'preview' && 'hidden'
              )}
            >
              {selectedWorkspace?.id && (
                <PreviewBrowserContainer
                  workspaceId={selectedWorkspace.id}
                  className=""
                />
              )}
            </div>

            {/* Git tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'git' && 'hidden'
              )}
            >
              {selectedWorkspace && (
                <RightSidebar
                  selectedWorkspace={selectedWorkspace}
                  repos={repos}
                />
              )}
            </div>
          </div>
        </ChangesViewProvider>
      </ReviewProvider>
    );

    return (
      <div className="flex flex-1 min-h-0 h-full flex-col">
        {header}
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 h-full">{mobileContent}</div>
        </div>
      </div>
    );
  }

  // Main area: VSCode-style tab groups (SHELL-SPEC R14-R16) replace the fixed
  // left/right split. The aside portals into the shell panel (SHELL-SPEC
  // R18/R30) but renders inside these providers — React context flows through
  // the component tree, not the DOM — so the file tree keeps talking to the
  // Changes view.
  // The aside follows what you're looking at: with an editor group focused
  // the workspace master-detail confused people ("I chose Editor, why am I
  // seeing workspace stuff?") — the editor gets its own aside instead.
  const isEditorFocused = tabGroups.some((g) => g.active === 'editor');

  const mainContent = (
    <ReviewProvider workspaceId={selectedWorkspace?.id}>
      <ChangesViewProvider>
        <ShellAsidePortal>
          {isEditorFocused && selectedWorkspace ? (
            <EditorAside
              workspaceId={selectedWorkspace.id}
              workspace={selectedWorkspace}
            />
          ) : (
            <RightSidebar
              selectedWorkspace={selectedWorkspace}
              repos={repos}
            />
          )}
        </ShellAsidePortal>
        <WorkspaceTabGroups
          groups={tabGroups}
          onGroupsChange={setTabGroups}
          contents={{
            chat: (
              <WorkspacesMainContainer
                ref={mainContainerRef}
                selectedWorkspace={selectedWorkspace ?? null}
                selectedSession={selectedSession}
                selectedSessionId={selectedSessionId}
                sessions={sessions}
                repos={repos}
                onSelectSession={selectSession}
                isLoading={isLoading}
                isSessionsLoading={isSessionsLoading}
                isNewSessionMode={isNewSessionMode}
                onStartNewSession={startNewSession}
              />
            ),
            changes: selectedWorkspace?.id ? (
              <ChangesPanelContainer
                className=""
                workspaceId={selectedWorkspace.id}
              />
            ) : null,
            editor: selectedWorkspace?.id ? (
              <EditorPanelContainer
                key={selectedWorkspace.id}
                className="h-full"
                workspaceId={selectedWorkspace.id}
              />
            ) : null,
            logs: <LogsContentContainer className="" />,
            preview: selectedWorkspace?.id ? (
              <PreviewBrowserContainer
                workspaceId={selectedWorkspace.id}
                className=""
              />
            ) : null,
          }}
        />
      </ChangesViewProvider>
    </ReviewProvider>
  );

  // Left sidebar now lives in the shell (SHELL-SPEC R9): the page contributes
  // its content through the shell sidebar portal and keeps the scroll wiring.
  // The rail's Editor item switches it to the file explorer of the selected
  // workspace (VSCode activity-bar style).
  const workspacesSidebarMode = useUiPreferencesStore(
    (s) => s.workspacesSidebarMode
  );

  // Explorer/search need a selected workspace (their worktree). Landing on
  // the section without one — e.g. clicking the rail's Editor item from the
  // welcome view — auto-opens the first active workspace so the sidebar
  // matches the rail state instead of silently falling back to the list.
  useEffect(() => {
    if (
      (workspacesSidebarMode === 'explorer' ||
        workspacesSidebarMode === 'search') &&
      !workspaceId &&
      !isWorkspacesListLoading &&
      activeWorkspaces.length > 0
    ) {
      appNavigation.goToWorkspace(activeWorkspaces[0].id, { replace: true });
    }
  }, [
    workspacesSidebarMode,
    workspaceId,
    isWorkspacesListLoading,
    activeWorkspaces,
    appNavigation,
  ]);

  // Follow the status-bar project selector: when the active repo changes and
  // the selected workspace doesn't belong to it, jump to the first active
  // workspace of that repo so the explorer/editor show the right project.
  const queryClient = useQueryClient();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const prevRepoIdRef = useRef(selectedRepoId);
  useEffect(() => {
    if (selectedRepoId === prevRepoIdRef.current) return;
    prevRepoIdRef.current = selectedRepoId;
    if (!selectedRepoId) return;
    if (repos.some((r) => r.id === selectedRepoId)) return;

    let cancelled = false;
    void (async () => {
      for (const candidate of activeWorkspaces) {
        try {
          const candidateRepos = await queryClient.fetchQuery({
            queryKey: ['workspace-repos-for-project-switch', candidate.id],
            queryFn: () => workspacesApi.getRepos(candidate.id),
            staleTime: 60_000,
          });
          if (cancelled) return;
          if (candidateRepos.some((r) => r.id === selectedRepoId)) {
            appNavigation.goToWorkspace(candidate.id);
            return;
          }
        } catch {
          // Unreachable workspace — try the next one.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, repos, activeWorkspaces, queryClient, appNavigation]);

  const sidebarPortal = (
    <ShellSidebarPortal>
      {workspacesSidebarMode === 'explorer' ? (
        <EditorSidebarContainer
          key={workspaceId ?? 'no-workspace'}
          workspaceId={workspaceId}
        />
      ) : workspacesSidebarMode === 'search' && workspaceId ? (
        <WorkspaceSearchSidebarContainer
          key={workspaceId}
          workspaceId={workspaceId}
        />
      ) : (
        <WorkspacesSidebarContainer onScrollToBottom={handleScrollToBottom} />
      )}
    </ShellSidebarPortal>
  );

  // The shell owns the aside panel and the terminal split (SHELL-SPEC
  // R18/R29/R30) — the page only fills the main column. No PageHeader on
  // desktop: the mock goes straight to the tab groups (the workspace name
  // lives in the navbar breadcrumbs and the aside title).
  return (
    <div className="flex flex-1 min-h-0 h-full flex-col">
      {sidebarPortal}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {mainContent}
      </div>
    </div>
  );
}
