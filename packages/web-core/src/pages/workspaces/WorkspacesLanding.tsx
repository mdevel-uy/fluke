import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { EditorSidebarContainer } from './EditorSidebarContainer';
import { WorkspacesWelcome } from './WorkspacesWelcome';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

/**
 * /workspaces with nothing selected — welcome view (SHELL-SPEC R13) instead
 * of the old redirect-to-create spinner. The sidebar follows the rail mode:
 * the Editor item gets its own sidebar (source picker) even with no
 * workspace routed, everything else shows the master list.
 */
export function WorkspacesLanding() {
  const workspacesSidebarMode = useUiPreferencesStore(
    (s) => s.workspacesSidebarMode
  );
  return (
    <>
      <ShellSidebarPortal>
        {workspacesSidebarMode === 'explorer' ? (
          <EditorSidebarContainer />
        ) : (
          <WorkspacesSidebarContainer />
        )}
      </ShellSidebarPortal>
      <WorkspacesWelcome />
    </>
  );
}
