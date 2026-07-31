import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { EditorSidebarContainer } from './EditorSidebarContainer';
import { EditorPanelContainer } from './EditorPanelContainer';
import { WorkspacesWelcome } from './WorkspacesWelcome';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useEditorSourceStore } from '@/shared/stores/useEditorSourceStore';
import { useWorkspaceEditorFiles } from '@/shared/stores/useWorkspaceEditorStore';
import { COMMIT_BROWSER_WORKSPACE_ID } from '@/shared/lib/commitFilePath';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/**
 * /workspaces with nothing selected — welcome view (SHELL-SPEC R13) instead
 * of the old redirect-to-create spinner. The sidebar follows the rail mode:
 * the Editor item gets its own sidebar (source picker) even with no
 * workspace routed. When commit-scoped buffers are open on the sentinel
 * host, the main area renders the editor so commit browsing works without
 * a single workspace in the fleet.
 */
export function WorkspacesLanding() {
  const { t } = useTranslation('common');
  const workspacesSidebarMode = useUiPreferencesStore(
    (s) => s.workspacesSidebarMode
  );
  const commitSource = useEditorSourceStore((s) => s.commitSource);
  const sentinelFiles = useWorkspaceEditorFiles(COMMIT_BROWSER_WORKSPACE_ID);
  const showCommitBrowser =
    workspacesSidebarMode === 'explorer' &&
    (commitSource !== null || sentinelFiles.openPaths.length > 0);

  // Search is worktree-scoped (needs a workspaceId). Landing here with mode
  // 'search' — e.g. clicking the rail's Search item from another section —
  // auto-opens the first active workspace so the sidebar renders the search
  // input instead of the workspaces list (fix for #295). Mirrors the same
  // hand-off WorkspacesLayout does when it mounts without a workspaceId.
  const { activeWorkspaces, isWorkspacesListLoading } = useWorkspaceContext();
  const appNavigation = useAppNavigation();
  useEffect(() => {
    if (
      workspacesSidebarMode === 'search' &&
      !isWorkspacesListLoading &&
      activeWorkspaces.length > 0
    ) {
      appNavigation.goToWorkspace(activeWorkspaces[0].id, { replace: true });
    }
  }, [
    workspacesSidebarMode,
    isWorkspacesListLoading,
    activeWorkspaces,
    appNavigation,
  ]);

  return (
    <>
      <ShellSidebarPortal>
        {workspacesSidebarMode === 'explorer' ? (
          <EditorSidebarContainer />
        ) : workspacesSidebarMode === 'search' ? (
          <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
            <div className="flex-none">
              <CollapsibleSectionHeader
                title={t('workspaces.explorer.searchTitle', {
                  defaultValue: 'Search',
                })}
                collapsible={false}
              />
            </div>
            <div className="px-3 py-2 text-xs text-low">
              {t('workspaces.explorer.searchNeedsWorkspace', {
                defaultValue: 'Select a workspace to search its files.',
              })}
            </div>
          </div>
        ) : (
          <WorkspacesSidebarContainer />
        )}
      </ShellSidebarPortal>
      {showCommitBrowser ? (
        <EditorPanelContainer
          workspaceId={COMMIT_BROWSER_WORKSPACE_ID}
          className="h-full"
        />
      ) : (
        <WorkspacesWelcome />
      )}
    </>
  );
}
