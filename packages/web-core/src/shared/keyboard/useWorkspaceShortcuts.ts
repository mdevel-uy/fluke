import { useCallback, useRef, useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useActions } from '@/shared/hooks/useActions';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { Actions } from '@/shared/actions';
import {
  type ActionDefinition,
  ActionTargetType,
} from '@/shared/types/actions';
import { Scope } from '@/shared/keyboard/registry';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { isMac } from '@/shared/lib/platform';
import { CLEANUP_SCRIPT_UI } from '@/shared/constants/features';

const SEQUENCE_TIMEOUT_MS = 1500;

const OPTIONS = {
  scopes: [Scope.WORKSPACE],
  sequenceTimeout: SEQUENCE_TIMEOUT_MS,
} as const;

export function useWorkspaceShortcuts() {
  const { executeAction } = useActions();
  const { workspaceId, repos } = useWorkspaceContext();

  const workspaceIdRef = useRef(workspaceId);
  const reposRef = useRef(repos);
  const executeActionRef = useRef(executeAction);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    reposRef.current = repos;
    executeActionRef.current = executeAction;
  });

  const execute = useCallback((action: ActionDefinition) => {
    const currentWorkspaceId = workspaceIdRef.current;
    const currentRepos = reposRef.current;
    const currentExecuteAction = executeActionRef.current;
    const firstRepoId = currentRepos?.[0]?.id;

    switch (action.requiresTarget) {
      case ActionTargetType.GIT:
        currentExecuteAction(action, currentWorkspaceId, firstRepoId);
        break;
      case ActionTargetType.WORKSPACE:
        currentExecuteAction(action, currentWorkspaceId);
        break;
      case ActionTargetType.NONE:
      case ActionTargetType.ISSUE:
        currentExecuteAction(action);
        break;
    }
  }, []);

  useHotkeys('g>s', () => execute(Actions.Settings), OPTIONS);

  useHotkeys('mod+shift+f', () => execute(Actions.SearchInFiles), OPTIONS);

  useHotkeys('w>r', () => execute(Actions.RenameWorkspace), OPTIONS);
  useHotkeys('w>p', () => execute(Actions.PinWorkspace), OPTIONS);
  useHotkeys('w>a', () => execute(Actions.ArchiveWorkspace), OPTIONS);
  useHotkeys('w>x', () => execute(Actions.DeleteWorkspace), OPTIONS);

  useHotkeys('v>c', () => execute(Actions.ToggleChangesMode), OPTIONS);
  useHotkeys('v>e', () => execute(Actions.ToggleEditorMode), OPTIONS);
  useHotkeys('v>l', () => execute(Actions.ToggleLogsMode), OPTIONS);
  useHotkeys('v>p', () => execute(Actions.TogglePreviewMode), OPTIONS);
  useHotkeys('v>s', () => execute(Actions.ToggleLeftSidebar), OPTIONS);
  useHotkeys('v>h', () => execute(Actions.ToggleLeftMainPanel), OPTIONS);

  useHotkeys('x>p', () => execute(Actions.GitCreatePR), OPTIONS);
  useHotkeys('x>m', () => execute(Actions.GitMerge), OPTIONS);
  useHotkeys('x>r', () => execute(Actions.GitRebase), OPTIONS);
  useHotkeys('x>u', () => execute(Actions.GitPush), OPTIONS);

  useHotkeys('y>p', () => execute(Actions.CopyWorkspacePath), OPTIONS);
  useHotkeys('y>l', () => execute(Actions.CopyRawLogs), OPTIONS);

  useHotkeys('t>d', () => execute(Actions.ToggleDevServer), OPTIONS);
  useHotkeys('t>w', () => execute(Actions.ToggleWrapLines), OPTIONS);

  useHotkeys('r>s', () => execute(Actions.RunSetupScript), OPTIONS);
  useHotkeys(
    'r>c',
    () => {
      if (CLEANUP_SCRIPT_UI) execute(Actions.RunCleanupScript);
    },
    OPTIONS
  );

  // Cmd+J (Mac) / Ctrl+J (Windows/Linux) toggles the terminal bottom panel.
  // Registered as a native listener on the capture phase so xterm can't
  // swallow the key first — mirrors useCommandBarShortcut for Cmd+K.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'j') return;

      event.preventDefault();
      event.stopPropagation();
      useUiPreferencesStore.getState().toggleTerminal();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);
}
