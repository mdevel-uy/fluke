import { useEffect } from 'react';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/**
 * /workspaces with nothing selected. Workspaces are reached through their
 * issue (Sesiones), so a bare landing has nothing of its own to show: the
 * rail's Search item jumps to the first active workspace (it needs a
 * worktree), everything else goes to Issues.
 */
export function WorkspacesLanding() {
  const workspacesSidebarMode = useUiPreferencesStore(
    (s) => s.workspacesSidebarMode
  );
  const { activeWorkspaces, isWorkspacesListLoading } = useWorkspaceContext();
  const appNavigation = useAppNavigation();

  useEffect(() => {
    if (isWorkspacesListLoading) return;
    if (workspacesSidebarMode === 'search' && activeWorkspaces.length > 0) {
      appNavigation.goToWorkspace(activeWorkspaces[0].id, { replace: true });
    } else {
      appNavigation.goToIssues(undefined, { replace: true });
    }
  }, [
    workspacesSidebarMode,
    isWorkspacesListLoading,
    activeWorkspaces,
    appNavigation,
  ]);

  return null;
}
