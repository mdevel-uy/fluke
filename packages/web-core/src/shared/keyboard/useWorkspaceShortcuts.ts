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
  useHotkeys('g>n', () => execute(Actions.NewWorkspace), OPTIONS);

  useHotkeys('w>d', () => execute(Actions.DuplicateWorkspace), OPTIONS);
  useHotkeys('w>r', () => execute(Actions.RenameWorkspace), OPTIONS);
  useHotkeys('w>p', () => execute(Actions.PinWorkspace), OPTIONS);
  useHotkeys('w>a', () => execute(Actions.ArchiveWorkspace), OPTIONS);
  useHotkeys('w>x', () => execute(Actions.DeleteWorkspace), OPTIONS);

  useHotkeys('v>c', () => execute(Actions.ToggleChangesMode), OPTIONS);
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
  useHotkeys('r>c', () => execute(Actions.RunCleanupScript), OPTIONS);

  // Cmd+J / Ctrl+J: toggle terminal bottom panel.
  // Uses a native window listener with capture: true so the shortcut fires
  // before xterm.js (which listens on the terminal element in the bubble
  // phase) can consume the key. Same pattern as useCommandBarShortcut.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;
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
