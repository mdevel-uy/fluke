import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { EditorSidebarContainer } from './EditorSidebarContainer';
import { EditorPanelContainer } from './EditorPanelContainer';
import { WorkspacesWelcome } from './WorkspacesWelcome';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useEditorSourceStore } from '@/shared/stores/useEditorSourceStore';
import { useWorkspaceEditorFiles } from '@/shared/stores/useWorkspaceEditorStore';
import { COMMIT_BROWSER_WORKSPACE_ID } from '@/shared/lib/commitFilePath';

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
