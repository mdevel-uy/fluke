import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import type { CreateModeInitialState } from '@/shared/types/createMode';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useMobileActiveTab } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';
import { CreateModeProvider } from '@/features/create-mode/model/CreateModeProvider';
import {
  consumeCreateModeSeedState,
  getCreateModeSeedVersion,
  subscribeCreateModeSeedState,
} from '@/features/create-mode/model/createModeSeedStore';
import { ReviewProvider } from '@/shared/hooks/ReviewProvider';
import { ChangesViewProvider } from '@/shared/hooks/ChangesViewProvider';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { ShellAsidePortal } from '@/shared/components/ui-new/shell/ShellAside';
import { LogsContentContainer } from './LogsContentContainer';
import {
  WorkspacesMainContainer,
  type WorkspacesMainContainerHandle,
} from './WorkspacesMainContainer';
import { RightSidebar } from './RightSidebar';
import { ChangesPanelContainer } from './ChangesPanelContainer';
import { CreateChatBoxContainer } from '@/shared/components/CreateChatBoxContainer';
import { PreviewBrowserContainer } from './PreviewBrowserContainer';
import { WorkspacesGuideDialog } from '@/shared/dialogs/shared/WorkspacesGuideDialog';
import { useUserSystem } from '@/shared/hooks/useUserSystem';

import { useWorkspaceTabGroups } from '@/shared/stores/useUiPreferencesStore';
import { WorkspaceTabGroups } from './WorkspaceTabGroups';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

const WORKSPACES_GUIDE_ID = 'workspaces-guide';

export function WorkspacesLayout() {
  const appNavigation = useAppNavigation();
  const {
    workspaceId,
    workspace: selectedWorkspace,
    isLoading,
    isCreateMode,
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
  const headerTitle = isCreateMode
    ? t('workspaces.newWorkspace')
    : (selectedWorkspace?.name ?? t('workspaces.title'));
  usePageTitle(
    isCreateMode ? t('workspaces.newWorkspace') : selectedWorkspace?.name
  );

  const header = <PageHeader title={headerTitle} />;

  const seedVersion = useSyncExternalStore(
    subscribeCreateModeSeedState,
    getCreateModeSeedVersion,
    getCreateModeSeedVersion
  );
  const consumedSeedVersionRef = useRef(0);
  const [createModeSeed, setCreateModeSeed] = useState<{
    version: number;
    state: CreateModeInitialState | null;
  }>({
    version: 0,
    state: null,
  });

  useEffect(() => {
    if (!isCreateMode) {
      consumedSeedVersionRef.current = 0;
      setCreateModeSeed((current) =>
        current.version === 0 && current.state === null
          ? current
          : { version: 0, state: null }
      );
      return;
    }

    if (seedVersion === 0 || seedVersion === consumedSeedVersionRef.current) {
      return;
    }

    consumedSeedVersionRef.current = seedVersion;
    setCreateModeSeed({
      version: seedVersion,
      state: consumeCreateModeSeedState(),
    });
  }, [isCreateMode, seedVersion]);

  const createModeProviderKey =
    createModeSeed.version > 0
      ? `create-mode-seed-${createModeSeed.version}`
      : 'create-mode-seed-default';

  const isMobile = useIsMobile();
  const [mobileTab] = useMobileActiveTab();
  const mainContainerRef = useRef<WorkspacesMainContainerHandle>(null);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      mainContainerRef.current?.scrollToBottom(behavior);
    },
    []
  );

  const handleWorkspaceCreated = useCallback(
    (workspaceId: string) => {
      appNavigation.goToWorkspace(workspaceId);
    },
    [appNavigation]
  );

  // VSCode-style tab groups (SHELL-SPEC R14)
  const [tabGroups, setTabGroups] = useWorkspaceTabGroups(
    isCreateMode ? undefined : workspaceId
  );

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
              {isCreateMode ? (
                <CreateChatBoxContainer
                  onWorkspaceCreated={handleWorkspaceCreated}
                />
              ) : (
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
              )}
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
              {selectedWorkspace && !isCreateMode && (
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
          <div className="flex-1 min-w-0 h-full">
            {isCreateMode ? (
              <CreateModeProvider
                key={createModeProviderKey}
                initialState={createModeSeed.state}
              >
                {mobileContent}
              </CreateModeProvider>
            ) : (
              mobileContent
            )}
          </div>
        </div>
      </div>
    );
  }

  // Main area: create mode keeps the plain chat box; otherwise VSCode-style
  // tab groups (SHELL-SPEC R14-R16) replace the fixed left/right split.
  // The aside portals into the shell panel (SHELL-SPEC R18/R30) but renders
  // inside these providers — React context flows through the component tree,
  // not the DOM — so the file tree keeps talking to the Changes view.
  const mainContent = (
    <ReviewProvider workspaceId={selectedWorkspace?.id}>
      <ChangesViewProvider>
        {!isCreateMode && (
          <ShellAsidePortal>
            <RightSidebar
              selectedWorkspace={selectedWorkspace}
              repos={repos}
            />
          </ShellAsidePortal>
        )}
        {isCreateMode ? (
          <CreateChatBoxContainer onWorkspaceCreated={handleWorkspaceCreated} />
        ) : (
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
              logs: <LogsContentContainer className="" />,
              preview: selectedWorkspace?.id ? (
                <PreviewBrowserContainer
                  workspaceId={selectedWorkspace.id}
                  className=""
                />
              ) : null,
            }}
          />
        )}
      </ChangesViewProvider>
    </ReviewProvider>
  );

  // Left sidebar now lives in the shell (SHELL-SPEC R9): the page contributes
  // its content through the shell sidebar portal and keeps the scroll wiring.
  const sidebarPortal = (
    <ShellSidebarPortal>
      <WorkspacesSidebarContainer onScrollToBottom={handleScrollToBottom} />
    </ShellSidebarPortal>
  );

  // The shell owns the aside panel and the terminal split (SHELL-SPEC
  // R18/R29/R30) — the page only fills the main column.
  return (
    <div className="flex flex-1 min-h-0 h-full flex-col">
      {sidebarPortal}
      {header}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {isCreateMode ? (
          <CreateModeProvider
            key={createModeProviderKey}
            initialState={createModeSeed.state}
          >
            {mainContent}
          </CreateModeProvider>
        ) : (
          mainContent
        )}
      </div>
    </div>
  );
}
