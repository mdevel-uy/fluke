import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Plus, Sparkles, X } from 'lucide-react';
import {
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { sessionsApi } from '@/shared/lib/api';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { ToolbarDropdown } from '@vibe/ui/components/Toolbar';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@vibe/ui/components/Dropdown';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import type { BaseCodingAgent } from 'shared/types';
import { useAdhocPanelStore } from '../model/useAdhocPanelStore';
import { useAdhocSession } from '../model/useAdhocSession';
import { AdhocChatPanelContent } from './AdhocChatPanelContent';

// Global ad-hoc chat panel — right-anchored slide-in that overlays the main
// column without collapsing it (portal to document.body, fixed positioning).
// Backed by the scratch workspace endpoint (one per repo) so chats are
// independent from the fleet workspaces and don't require an issue.

export function AdhocClaudePanel() {
  const { t } = useTranslation('common');
  const { t: tTasks } = useTranslation('tasks');
  const isOpen = useAdhocPanelStore((s) => s.isOpen);
  const close = useAdhocPanelStore((s) => s.close);
  const queryClient = useQueryClient();
  const hostId = useHostId();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const {
    workspaceContext,
    workspaceId,
    selectedSession,
    sessions,
    selectSession,
    startNewSession,
    isStartingNewSession,
    isLoading,
    isReady,
    error,
    retry,
    repoId,
  } = useAdhocSession({ enabled: isOpen });

  // Focus management: move focus into the panel on open and return it to
  // the previously focused element (typically the toggle) on close so
  // keyboard users don't lose their place.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer to next frame so the panel is mounted before we focus it.
    const raf = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const target = previouslyFocusedRef.current;
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [isOpen]);

  // Escape closes the panel from anywhere (matches drawer conventions).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  const handleNewSession = useCallback(() => {
    void startNewSession();
  }, [startNewSession]);

  const handleRenameSession = useCallback(
    (targetSessionId: string, currentName: string) => {
      void RenameSessionDialog.show({
        currentName,
        onRename: async (newName: string) => {
          await sessionsApi.update(targetSessionId, { name: newName });
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        },
      });
    },
    [queryClient, hostId, workspaceId]
  );

  // Session chip in the panel header — in the compact composer the session
  // dropdown no longer lives inside the chat box, it belongs to the drawer.
  const isLatestSelected =
    sessions.length > 0 && selectedSession?.id === sessions[0].id;
  const sessionChipLabel = selectedSession?.name
    ? selectedSession.name
    : isLatestSelected
      ? tTasks('conversation.sessions.latest')
      : tTasks('conversation.sessions.previous');

  const panelLabel = t('adhocPanel.title', { defaultValue: 'Ad-hoc Claude' });
  const closeLabel = t('adhocPanel.close', {
    defaultValue: 'Close ad-hoc Claude panel',
  });
  const newSessionLabel = t('adhocPanel.newSession', {
    defaultValue: 'Nueva sesión',
  });

  return createPortal(
    <aside
      ref={panelRef}
      role="complementary"
      aria-label={panelLabel}
      aria-hidden={!isOpen}
      className={cn(
        'fixed right-0 top-0 h-full w-full max-w-[380px] z-[80]',
        'bg-primary border-l border-md-outline-variant shadow-overlay',
        'flex flex-col transition-transform duration-200 ease-out',
        isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
      )}
    >
      <div className="flex items-center justify-between gap-2 h-10 px-3 border-b border-md-outline-variant shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles
            className="h-4 w-4 text-brand-on-surface shrink-0"
            strokeWidth={1.75}
          />
          <span className="text-sm font-medium text-high truncate shrink-0">
            {panelLabel}
          </span>
          {isReady && selectedSession && (
            <ToolbarDropdown
              label={sessionChipLabel}
              className="min-w-0 max-w-[140px]"
            >
              <DropdownMenuItem icon={PlusIcon} onClick={handleNewSession}>
                {tTasks('conversation.sessions.newSession')}
              </DropdownMenuItem>
              {sessions.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>
                    {tTasks('conversation.sessions.label')}
                  </DropdownMenuLabel>
                  {sessions.map((s, index) => (
                    <DropdownMenuItem
                      key={s.id}
                      icon={
                        s.id === selectedSession.id ? CheckIcon : undefined
                      }
                      onClick={() => selectSession(s.id)}
                    >
                      <span className="flex items-center gap-1.5 max-w-[200px]">
                        <AgentIcon
                          agent={
                            (s.executor ?? null) as
                              | BaseCodingAgent
                              | null
                              | undefined
                          }
                          className="size-icon shrink-0"
                        />
                        <span className="truncate">
                          {s.name
                            ? s.name
                            : index === 0
                              ? tTasks('conversation.sessions.latest')
                              : formatDateShortWithTime(s.created_at)}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={PencilSimpleIcon}
                onClick={() =>
                  handleRenameSession(
                    selectedSession.id,
                    selectedSession.name ?? ''
                  )
                }
              >
                {tTasks('conversation.sessions.rename')}
              </DropdownMenuItem>
            </ToolbarDropdown>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleNewSession}
            disabled={!isReady || isStartingNewSession}
            className="p-1 rounded-md text-low hover:text-high hover:bg-secondary/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={newSessionLabel}
            title={newSessionLabel}
          >
            {isStartingNewSession ? (
              <SpinnerIcon className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={close}
            className="p-1 rounded-md text-low hover:text-high hover:bg-secondary/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {!isOpen ? null : !repoId ? (
          <AdhocEmptyState
            title={t('adhocPanel.noRepo.title', {
              defaultValue: 'Sin repositorio disponible',
            })}
            description={t('adhocPanel.noRepo.description', {
              defaultValue:
                'Agregá un repositorio para poder iniciar una sesión ad-hoc de Claude.',
            })}
          />
        ) : error ? (
          <AdhocErrorState error={error} onRetry={retry} />
        ) : isLoading || !isReady || !workspaceContext || !selectedSession ? (
          <AdhocLoadingState />
        ) : (
          <AdhocChatPanelContent
            workspaceContext={workspaceContext}
            selectedSession={selectedSession}
            sessions={sessions}
            onSelectSession={selectSession}
            onStartNewSession={handleNewSession}
          />
        )}
      </div>
    </aside>,
    document.body
  );
}

function AdhocEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary/60 text-brand-on-surface">
        <Sparkles className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium text-high">{title}</p>
      <p className="text-xs text-low max-w-[260px]">{description}</p>
    </div>
  );
}

function AdhocLoadingState() {
  const { t } = useTranslation('common');
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <SpinnerIcon className="h-6 w-6 animate-spin text-low" />
      <p className="text-xs text-low">
        {t('adhocPanel.loading', {
          defaultValue: 'Preparando la sesión de Claude…',
        })}
      </p>
    </div>
  );
}

function AdhocErrorState({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary/60 text-danger">
        <AlertCircle className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium text-high">
        {t('adhocPanel.error.title', {
          defaultValue: 'No pudimos abrir la sesión ad-hoc',
        })}
      </p>
      <p className="text-xs text-low max-w-[260px] break-words">
        {error.message ||
          t('adhocPanel.error.description', {
            defaultValue: 'Ocurrió un error al preparar el workspace scratch.',
          })}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 px-3 py-1.5 text-xs font-medium rounded-md border border-md-outline-variant text-high hover:bg-secondary/60 transition-colors"
      >
        {t('adhocPanel.error.retry', { defaultValue: 'Reintentar' })}
      </button>
    </div>
  );
}
