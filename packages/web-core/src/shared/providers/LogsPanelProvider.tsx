import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { LogsPanelContent } from '@/shared/types/actions';
import {
  useUiPreferencesStore,
  useWorkspaceActiveViewTabs,
} from '@/shared/stores/useUiPreferencesStore';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import {
  LogsPanelActionsContext,
  LogsPanelContext,
} from '@/shared/hooks/useLogsPanel';

interface LogsPanelProviderProps {
  children: ReactNode;
}

export function LogsPanelProvider({ children }: LogsPanelProviderProps) {
  const { workspaceId, isCreateMode } = useWorkspaceContext();
  const effectiveWorkspaceId = isCreateMode ? undefined : workspaceId;
  const activeViewTabs = useWorkspaceActiveViewTabs(effectiveWorkspaceId);
  const isLogsViewActive = activeViewTabs.includes('logs');
  const openWorkspaceViewTab = useUiPreferencesStore(
    (s) => s.openWorkspaceViewTab
  );
  const effectiveWorkspaceIdRef = useRef(effectiveWorkspaceId);
  effectiveWorkspaceIdRef.current = effectiveWorkspaceId;
  const [logsPanelContent, setLogsPanelContent] =
    useState<LogsPanelContent | null>(null);
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [logMatchIndices, setLogMatchIndices] = useState<number[]>([]);
  const [logCurrentMatchIdx, setLogCurrentMatchIdx] = useState(0);

  const logContentId =
    logsPanelContent?.type === 'process'
      ? logsPanelContent.processId
      : logsPanelContent?.type === 'tool'
        ? logsPanelContent.toolName
        : null;

  useEffect(() => {
    setLogSearchQuery('');
    setLogCurrentMatchIdx(0);
  }, [logContentId]);

  useEffect(() => {
    setLogCurrentMatchIdx(0);
  }, [logSearchQuery]);

  // Clear the logs panel content when the Logs view stops being visible.
  useEffect(() => {
    if (!isLogsViewActive) {
      setLogsPanelContent(null);
    }
  }, [isLogsViewActive]);

  const handleLogPrevMatch = useCallback(() => {
    if (logMatchIndices.length === 0) return;
    setLogCurrentMatchIdx((prev) =>
      prev > 0 ? prev - 1 : logMatchIndices.length - 1
    );
  }, [logMatchIndices.length]);

  const handleLogNextMatch = useCallback(() => {
    if (logMatchIndices.length === 0) return;
    setLogCurrentMatchIdx((prev) =>
      prev < logMatchIndices.length - 1 ? prev + 1 : 0
    );
  }, [logMatchIndices.length]);

  const viewProcessInPanel = useCallback(
    (processId: string) => {
      openWorkspaceViewTab(effectiveWorkspaceIdRef.current, 'logs');
      setLogsPanelContent({ type: 'process', processId });
    },
    [openWorkspaceViewTab]
  );

  const viewToolContentInPanel = useCallback(
    (toolName: string, content: string, command?: string) => {
      openWorkspaceViewTab(effectiveWorkspaceIdRef.current, 'logs');
      setLogsPanelContent({ type: 'tool', toolName, content, command });
    },
    [openWorkspaceViewTab]
  );

  const actionsValue = useMemo(
    () => ({
      viewProcessInPanel,
      viewToolContentInPanel,
    }),
    [viewProcessInPanel, viewToolContentInPanel]
  );

  const value = useMemo(
    () => ({
      logsPanelContent,
      logSearchQuery,
      logMatchIndices,
      logCurrentMatchIdx,
      setLogSearchQuery,
      setLogMatchIndices,
      handleLogPrevMatch,
      handleLogNextMatch,
      viewProcessInPanel,
      viewToolContentInPanel,
    }),
    [
      logsPanelContent,
      logSearchQuery,
      logMatchIndices,
      logCurrentMatchIdx,
      handleLogPrevMatch,
      handleLogNextMatch,
      viewProcessInPanel,
      viewToolContentInPanel,
    ]
  );

  return (
    <LogsPanelActionsContext.Provider value={actionsValue}>
      <LogsPanelContext.Provider value={value}>
        {children}
      </LogsPanelContext.Provider>
    </LogsPanelActionsContext.Provider>
  );
}
