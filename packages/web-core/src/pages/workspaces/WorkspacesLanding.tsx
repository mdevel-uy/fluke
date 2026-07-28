import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { WorkspacesWelcome } from './WorkspacesWelcome';

/**
 * /workspaces with nothing selected — welcome view (SHELL-SPEC R13) instead
 * of the old redirect-to-create spinner. The workspaces sidebar is
 * contributed here too, so the master list stays visible.
 */
export function WorkspacesLanding() {
  return (
    <>
      <ShellSidebarPortal>
        <WorkspacesSidebarContainer />
      </ShellSidebarPortal>
      <WorkspacesWelcome />
    </>
  );
}
