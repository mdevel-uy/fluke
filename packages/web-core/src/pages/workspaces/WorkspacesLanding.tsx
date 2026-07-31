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
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
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

  // Search needs a worktree — auto-jump to the first active workspace so the
  // rail's Search item lands on a working sidebar instead of the workspaces
  // list. Mirrors the equivalent effect in WorkspacesLayout for parity.
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

  // `isEmptyFleet` only settles once the fleet stream has loaded; during the
  // transient window before the auto-jump navigates away we render just the
  // Search header so the sidebar doesn't flash a stale message.
  const isEmptyFleet =
    !isWorkspacesListLoading && activeWorkspaces.length === 0;

  return (
    <>
      <ShellSidebarPortal>
        {workspacesSidebarMode === 'explorer' ? (
          <EditorSidebarContainer />
        ) : workspacesSidebarMode === 'search' ? (
          <WorkspaceSearchSidebarPlaceholder isEmptyFleet={isEmptyFleet} />
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

/**
 * Rendered on the landing route while the search mode is active but no
 * workspace is selected yet (the auto-jump effect is about to run, or the
 * fleet is empty and there's nothing to search). Keeps the shell sidebar
 * from flashing the workspaces list under the Search rail item, and — when
 * the fleet is empty — surfaces a hint instead of a bare blank div.
 */
function WorkspaceSearchSidebarPlaceholder({
  isEmptyFleet,
}: {
  isEmptyFleet: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('workspaces.explorer.searchTitle', {
            defaultValue: 'Search',
          })}
          collapsible={false}
        />
      </div>
      {isEmptyFleet && (
        <div className="px-3 py-2 text-xs text-low">
          {t('workspaces.explorer.searchEmptyFleet', {
            defaultValue:
              'Assign an issue to a worker to create a workspace, then search inside it.',
          })}
        </div>
      )}
    </div>
  );
}
