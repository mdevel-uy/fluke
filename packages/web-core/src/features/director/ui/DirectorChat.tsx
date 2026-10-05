import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react';
import type { Session, WorkspaceContext } from 'shared/types';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { forwardWheelToScroller } from '@/features/workspace-chat/ui/forwardWheelToScroller';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import {
  AssistantChatContext,
  FlukeRepoSlugContext,
} from '@/features/workspace-chat/model/contexts/AssistantChatContext';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { createWorkspaceWithSession } from '@/shared/types/attempt';

/**
 * Conversation of one Director mission: its session runs in the scratch
 * workspace of the repo that was active when the mission started. Duplicates
 * the provider stack from WorkspacesMainContainer (chat state is
 * session-scoped and lives in React contexts, not global stores). Keying the
 * providers on `${workspaceId}-${sessionId}` remounts them when the user
 * switches missions so entries, edit state and approvals reset.
 */
interface DirectorChatProps {
  workspaceContext: WorkspaceContext;
  selectedSession: Session;
  /** Rendered between the transcript and the composer (quick replies). */
  aboveComposer?: ReactNode;
  /** Shown instead of the transcript while the conversation is empty. */
  emptyState?: ReactNode;
}

const noop = () => {};

export function DirectorChat({
  workspaceContext,
  selectedSession,
  aboveComposer,
  emptyState,
}: DirectorChatProps) {
  const sessions = useMemo(() => [selectedSession], [selectedSession]);
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
    <AssistantChatContext.Provider value>
      <FlukeRepoSlugContext.Provider
        value={repos.find((r) => r.name.includes('/'))?.name ?? null}
      >
        <ExecutionProcessesProvider
          key={scopeKey}
          sessionId={selectedSession.id}
        >
          <ApprovalFeedbackProvider>
            <EntriesProvider key={scopeKey}>
              <MessageEditProvider>
                <div
                  ref={containerRef}
                  className="flex h-full min-h-0 flex-col overflow-hidden"
                >
                  <div
                    className="relative flex flex-1 min-h-0 justify-center overflow-hidden"
                    onWheel={(e) =>
                      forwardWheelToScroller(e, conversationListRef)
                    }
                  >
                    <div className="h-full w-chat max-w-full">
                      <RetryUiProvider workspaceId={workspace.id}>
                        <ConversationList
                          key={scopeKey}
                          ref={conversationListRef}
                          attempt={workspaceWithSession}
                          repos={repos}
                          onAtBottomChange={handleAtBottomChange}
                          sessionScopeId={selectedSession.id}
                          emptyState={emptyState}
                        />
                      </RetryUiProvider>
                    </div>
                    {/* Floating read-navigation: only while scrolled up, so it
                    never sits next to the composer's send button. In compact
                    mode these replace the composer-header turn navigation. */}
                    {!isAtBottom && (
                      <div className="absolute bottom-2 right-3 z-10 flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={handleScrollToPreviousMessage}
                          className="flex items-center justify-center size-8 rounded-full bg-secondary/80 backdrop-blur-sm border border-secondary text-low hover:text-normal hover:bg-secondary shadow-md transition-all"
                          aria-label={t(
                            'conversation.scrollToPreviousMessage',
                            {
                              defaultValue: 'Scroll to previous message',
                            }
                          )}
                          title={t('conversation.scrollToPreviousMessage', {
                            defaultValue: 'Scroll to previous message',
                          })}
                        >
                          <ArrowUpIcon
                            className="size-icon-base"
                            weight="bold"
                          />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleScrollToBottom('auto')}
                          className="flex items-center justify-center size-8 rounded-full bg-secondary/80 backdrop-blur-sm border border-secondary text-low hover:text-normal hover:bg-secondary shadow-md transition-all"
                          aria-label={t('conversation.scrollToBottom', {
                            defaultValue: 'Scroll to bottom',
                          })}
                          title={t('conversation.scrollToBottom', {
                            defaultValue: 'Scroll to bottom',
                          })}
                        >
                          <ArrowDownIcon
                            className="size-icon-base"
                            weight="bold"
                          />
                        </button>
                      </div>
                    )}
                  </div>
                  <div
                    className="@container flex shrink-0 justify-center border-t border-md-outline-variant bg-panel p-4 dark:bg-md-surface-container-low"
                    data-chatbox-container="true"
                  >
                    {/* Centered like the workspace chat; quick replies share the
                    composer's width so they line up with it. */}
                    <div className="flex w-chat max-w-full flex-col">
                      {aboveComposer}
                      <SessionChatBoxContainer
                        mode="existing-session"
                        compact
                        hideModelSelector
                        session={selectedSession}
                        sessions={sessions}
                        onSelectSession={noop}
                        onStartNewSession={undefined}
                        filesChanged={0}
                        linesAdded={0}
                        linesRemoved={0}
                        disableViewCode
                        showOpenWorkspaceButton={false}
                        onScrollToPreviousMessage={
                          handleScrollToPreviousMessage
                        }
                        onScrollToBottom={handleScrollToBottom}
                        onScrollToUserMessage={handleScrollToUserMessage}
                        getActiveTurnPatchKey={handleGetActiveTurnPatchKey}
                      />
                    </div>
                  </div>
                </div>
              </MessageEditProvider>
            </EntriesProvider>
          </ApprovalFeedbackProvider>
        </ExecutionProcessesProvider>
      </FlukeRepoSlugContext.Provider>
    </AssistantChatContext.Provider>
  );
}
