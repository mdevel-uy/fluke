import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from '@phosphor-icons/react';
import type { Session, WorkspaceContext } from 'shared/types';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { createWorkspaceWithSession } from '@/shared/types/attempt';

/**
 * Interior of the ad-hoc panel, wired around a single scratch workspace and
 * its currently selected session. Duplicates the provider stack from
 * WorkspacesMainContainer / ProjectRightSidebarContainer (chat state is
 * session-scoped and lives in React contexts, not global stores). Keying the
 * providers on `${workspaceId}-${sessionId}` guarantees a full remount when
 * the user clicks "Nueva sesión" so entries, edit state and approvals reset.
 */
interface AdhocChatPanelContentProps {
  workspaceContext: WorkspaceContext;
  selectedSession: Session;
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onStartNewSession: () => void;
}

export function AdhocChatPanelContent({
  workspaceContext,
  selectedSession,
  sessions,
  onSelectSession,
  onStartNewSession,
}: AdhocChatPanelContentProps) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const conversationListRef = useRef<ConversationListHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(isAtBottom);

  const { workspace, workspace_repos: repos } = workspaceContext;

  const workspaceWithSession = useMemo(
    () => createWorkspaceWithSession(workspace, selectedSession),
    [workspace, selectedSession]
  );

  const scopeKey = `${workspace.id}-${selectedSession.id}`;

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  const handleScrollToPreviousMessage = useCallback(() => {
    conversationListRef.current?.scrollToPreviousUserMessage();
  }, []);

  const handleScrollToUserMessage = useCallback((patchKey: string) => {
    conversationListRef.current?.scrollToEntryByPatchKey(patchKey);
  }, []);

  const handleGetActiveTurnPatchKey = useCallback(
    () => conversationListRef.current?.getVisibleUserMessagePatchKey() ?? null,
    []
  );

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      conversationListRef.current?.scrollToBottom(behavior);
    },
    []
  );

  // Adopt the same chat-height correction the workspaces view uses so
  // fluctuations in the composer (e.g. attachments, feedback banner) don't
  // scroll the transcript off the bottom when the user was already pinned.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const chatBoxContainer = container.querySelector<HTMLElement>(
      '[data-chatbox-container="true"]'
    );
    if (!chatBoxContainer) return;

    let previousHeight = chatBoxContainer.getBoundingClientRect().height;

    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ??
        chatBoxContainer.getBoundingClientRect().height;
      if (Math.abs(nextHeight - previousHeight) < 0.5) return;
      const heightDelta = nextHeight - previousHeight;
      previousHeight = nextHeight;
      if (!isAtBottomRef.current) return;
      requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        conversationListRef.current?.adjustScrollBy(heightDelta);
      });
    });

    observer.observe(chatBoxContainer);
    return () => observer.disconnect();
  }, [scopeKey]);

  return (
    <ExecutionProcessesProvider key={scopeKey} sessionId={selectedSession.id}>
      <ApprovalFeedbackProvider>
        <EntriesProvider key={scopeKey}>
          <MessageEditProvider>
            <div
              ref={containerRef}
              className="flex h-full min-h-0 flex-col overflow-hidden"
            >
              <div className="relative flex-1 min-h-0 overflow-hidden">
                <RetryUiProvider workspaceId={workspace.id}>
                  <ConversationList
                    key={scopeKey}
                    ref={conversationListRef}
                    attempt={workspaceWithSession}
                    repos={repos}
                    onAtBottomChange={handleAtBottomChange}
                    sessionScopeId={selectedSession.id}
                  />
                </RetryUiProvider>
                {!isAtBottom && (
                  <button
                    type="button"
                    onClick={() => handleScrollToBottom('auto')}
                    className="absolute bottom-2 right-3 z-10 flex items-center justify-center size-8 rounded-full bg-secondary/80 backdrop-blur-sm border border-secondary text-low hover:text-normal hover:bg-secondary shadow-md transition-all"
                    aria-label={t('conversation.scrollToBottom', {
                      defaultValue: 'Scroll to bottom',
                    })}
                    title={t('conversation.scrollToBottom', {
                      defaultValue: 'Scroll to bottom',
                    })}
                  >
                    <ArrowDownIcon className="size-icon-base" weight="bold" />
                  </button>
                )}
              </div>
              <div
                className="@container shrink-0 pl-px"
                data-chatbox-container="true"
              >
                <SessionChatBoxContainer
                  mode="existing-session"
                  session={selectedSession}
                  sessions={sessions}
                  onSelectSession={onSelectSession}
                  onStartNewSession={onStartNewSession}
                  filesChanged={0}
                  linesAdded={0}
                  linesRemoved={0}
                  disableViewCode
                  showOpenWorkspaceButton={false}
                  onScrollToPreviousMessage={handleScrollToPreviousMessage}
                  onScrollToBottom={handleScrollToBottom}
                  onScrollToUserMessage={handleScrollToUserMessage}
                  getActiveTurnPatchKey={handleGetActiveTurnPatchKey}
                />
              </div>
            </div>
          </MessageEditProvider>
        </EntriesProvider>
      </ApprovalFeedbackProvider>
    </ExecutionProcessesProvider>
  );
}
