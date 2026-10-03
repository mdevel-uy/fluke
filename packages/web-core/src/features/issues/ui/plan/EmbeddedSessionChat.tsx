import { useCallback, useMemo, useRef } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { useWorkspaceSessions } from '@/shared/hooks/useWorkspaceSessions';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { createWorkspaceWithSession } from '@/shared/types/attempt';

/**
 * Agent conversation of one workspace, embedded in the issue page's
 * "Sesiones" tab (#689). Same building blocks as the kanban side panel
 * (ProjectRightSidebarContainer) without its header and without any URL
 * dependency. Shows the latest session of the workspace; the composer only
 * when the phase is live, otherwise the transcript is read-only.
 */
export function EmbeddedSessionChat({
  workspaceId,
  live,
}: {
  workspaceId: string;
  live: boolean;
}) {
  const listRef = useRef<ConversationListHandle>(null);
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const { data: workspace, isLoading: isWorkspaceLoading } = useWorkspaceRecord(
    workspaceId,
    { enabled: true }
  );
  const {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    isLoading: isSessionsLoading,
    startNewSession,
  } = useWorkspaceSessions(workspaceId, { enabled: true });

  const summary = useMemo(
    () =>
      [...activeWorkspaces, ...archivedWorkspaces].find(
        (w) => w.id === workspaceId
      ),
    [activeWorkspaces, archivedWorkspaces, workspaceId]
  );
  const attempt = useMemo(
    () =>
      workspace ? createWorkspaceWithSession(workspace, selectedSession) : null,
    [workspace, selectedSession]
  );
  const scrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') =>
      listRef.current?.scrollToBottom(behavior),
    []
  );

  const key = `${workspaceId}-${selectedSessionId ?? 'none'}`;
  return (
    <ExecutionProcessesProvider key={key} sessionId={selectedSessionId}>
      <ApprovalFeedbackProvider>
        <EntriesProvider key={key}>
          <MessageEditProvider>
            <div className="flex h-full min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
                <div className="h-full w-chat max-w-full">
                  {attempt && (
                    <RetryUiProvider workspaceId={attempt.id}>
                      <ConversationList
                        key={key}
                        ref={listRef}
                        attempt={attempt}
                        sessionScopeId={selectedSessionId}
                      />
                    </RetryUiProvider>
                  )}
                </div>
              </div>
              {live && (
                <div className="flex justify-center pl-px @container">
                  <SessionChatBoxContainer
                    {...(isSessionsLoading ||
                    isWorkspaceLoading ||
                    !selectedSession
                      ? { mode: 'placeholder' as const }
                      : {
                          mode: 'existing-session' as const,
                          session: selectedSession,
                          onSelectSession: selectSession,
                          onStartNewSession: startNewSession,
                        })}
                    sessions={sessions}
                    filesChanged={summary?.filesChanged ?? 0}
                    linesAdded={summary?.linesAdded ?? 0}
                    linesRemoved={summary?.linesRemoved ?? 0}
                    disableViewCode
                    showOpenWorkspaceButton
                    onScrollToPreviousMessage={() =>
                      listRef.current?.scrollToPreviousUserMessage()
                    }
                    onScrollToBottom={scrollToBottom}
                    onScrollToUserMessage={(patchKey: string) =>
                      listRef.current?.scrollToEntryByPatchKey(patchKey)
                    }
                    getActiveTurnPatchKey={() =>
                      listRef.current?.getVisibleUserMessagePatchKey() ?? null
                    }
                  />
                </div>
              )}
            </div>
          </MessageEditProvider>
        </EntriesProvider>
      </ApprovalFeedbackProvider>
    </ExecutionProcessesProvider>
  );
}
