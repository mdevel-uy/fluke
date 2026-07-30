import { useEffect } from 'react';
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
  const workspacesSidebarMode = useUiPreferencesStore(
    (s) => s.workspacesSidebarMode
  );
  const commitSource = useEditorSourceStore((s) => s.commitSource);
  const sentinelFiles = useWorkspaceEditorFiles(COMMIT_BROWSER_WORKSPACE_ID);
  const showCommitBrowser =
    workspacesSidebarMode === 'explorer' &&
    (commitSource !== null || sentinelFiles.openPaths.length > 0);

  // Search is scoped to a workspace worktree: clicking the rail's Search
  // item from the landing (or from another section) sets the mode to
  // 'search' and lands here without a workspaceId. Auto-open the first
  // active workspace so WorkspacesLayout can render WorkspaceSearchSidebar
  // instead of silently falling back to the workspaces list. Mirrors the
  // effect in WorkspacesLayout for the /workspaces/{id} case.
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
