import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import {
  findPreviousUserMessageIndex,
  type ConversationRow,
} from '../model/conversation-row-model';
import { deriveConversationEntries } from '../model/deriveConversationEntries';
import { deriveConversationTimeline } from '../model/deriveConversationTimeline';
import { useConversationVirtualizer } from '../model/useConversationVirtualizer';
import { useScrollCommandExecutor } from '../model/useScrollCommandExecutor';

import DisplayConversationEntry from './DisplayConversationEntry';
import { useIsAssistantChat } from '../model/contexts/AssistantChatContext';
import {
  eventLines,
  isEventsBatch,
  isSilentReply,
  stripFlukeContext,
} from '@/features/director/lib/events';
import { FlukeOrbParts } from '@/features/director/ui/MissionRing';
import { FlukeTelemetry } from '@/features/director/ui/FlukeTelemetry';
import { cn } from '@/shared/lib/utils';
import { ApprovalFormProvider } from '@/shared/hooks/ApprovalForm';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useEntriesActions } from '../model/contexts/EntriesContext';
import {
  useResetProcess,
  type UseResetProcessResult,
} from '../model/hooks/useResetProcess';
import type {
  AddEntryType,
  ConversationTimelineSource,
  DisplayEntry,
} from '@/shared/hooks/useConversationHistory/types';
import {
  isAggregatedGroup,
  isAggregatedDiffGroup,
  isAggregatedThinkingGroup,
} from '@/shared/hooks/useConversationHistory/types';
import { useConversationHistory } from '../model/hooks/useConversationHistory';
import { useSetTokenUsageInfo } from '../model/contexts/EntriesContext';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import type { RepoWithTargetBranch } from 'shared/types';
import { ChatEmptyState } from '@vibe/ui/components/ChatEmptyState';
import { ChatScriptPlaceholder } from '@vibe/ui/components/ChatScriptPlaceholder';
import { ScriptFixerDialog } from '@/shared/dialogs/scripts/ScriptFixerDialog';

interface ConversationListProps {
  attempt: WorkspaceWithSession;
  repos?: RepoWithTargetBranch[];
  onAtBottomChange?: (atBottom: boolean) => void;
  sessionScopeId?: string;
  /** Replaces the default empty state (Fluke greets instead). */
  emptyState?: React.ReactNode;
}

export interface ConversationListHandle {
  scrollToPreviousUserMessage: () => void;
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  adjustScrollBy: (delta: number) => void;
  getScrollElement: () => HTMLDivElement | null;
  scrollToEntryByPatchKey: (patchKey: string) => void;
  getVisibleUserMessagePatchKey: () => string | null;
}

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const STREAMING_UNVIRTUALIZED_BUFFER_ROWS = 24;

function renderRowContent(
  entry: DisplayEntry,
  attempt: WorkspaceWithSession,
  resetAction: UseResetProcessResult,
  repos: RepoWithTargetBranch[]
): React.ReactNode {
  if (isAggregatedGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={entry}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={null}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (isAggregatedDiffGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={null}
        aggregatedDiffGroup={entry}
        aggregatedThinkingGroup={null}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (isAggregatedThinkingGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={null}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={entry}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (entry.type === 'STDOUT') {
    return <p>{entry.content}</p>;
  }
  if (entry.type === 'STDERR') {
    return <p>{entry.content}</p>;
  }

  if (entry.type === 'NORMALIZED_ENTRY') {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        entry={entry.content}
        aggregatedGroup={null}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  return null;
}

// Assistant chat: the first visible Fluke row after a user message opens a
// turn and carries the author header. Hidden families (scripts, raw tool
// calls, empty reasoning) must not, or the header would vanish with them.
function opensAssistantTurn(entry: DisplayEntry): boolean {
  if (isAggregatedThinkingGroup(entry)) return true;
  if (entry.type !== 'NORMALIZED_ENTRY') return false;
  const { entry_type, content } = entry.content;
  if (entry_type.type === 'loading') return true;
  // A SILENT reply to app events renders nothing: no header for it either.
  if (entry_type.type === 'assistant_message' && isSilentReply(content))
    return false;
  if (entry_type.type === 'assistant_message' || entry_type.type === 'thinking')
    return content.trim().length > 0;
  return false;
}

function entryTimestamp(entry: DisplayEntry): string | null {
  return entry.type === 'NORMALIZED_ENTRY' ? entry.content.timestamp : null;
}

/** A batch of app events Fluke received: its lines, else null. */
function eventsBatchLines(entry: DisplayEntry): string[] | null {
  if (
    entry.type !== 'NORMALIZED_ENTRY' ||
    entry.content.entry_type.type !== 'user_message'
  )
    return null;
  const content = stripFlukeContext(entry.content.content);
  return isEventsBatch(content) ? eventLines(content) : null;
}

/** "12s", "4m 05s", "1h 02m": short enough for the margin. */
function formatTook(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Fluke's chat (design option C, "transmisión"): who, when and how long
 * Fluke took sit in a margin column. The latest turn adds the live orb and
 * "now".
 */

function TurnMargin({
  timestamp,
  you = false,
  now = false,
  live = false,
  tookMs,
}: {
  timestamp: string | null;
  you?: boolean;
  now?: boolean;
  live?: boolean;
  /** How long Fluke took to answer this turn. */
  tookMs?: number;
}) {
  const { t } = useTranslation('common');
  const time =
    timestamp &&
    new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  const took = tookMs !== undefined && (
    <span
      className="text-low/60"
      title={t('director.tookTitle', { took: formatTook(tookMs) })}
    >
      {formatTook(tookMs)}
    </span>
  );
  if (now) {
    return (
      <div className="flex flex-col items-end gap-1.5 pt-0.5">
        <span
          className="fluke-orb"
          data-state={live ? 'working' : 'idle'}
          style={{ '--orb-size': '26px' } as CSSProperties}
        >
          <FlukeOrbParts markSize={11} />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-brand-on-surface">
          {t('director.now')}
        </span>
        <span className="flex flex-col items-end gap-1 font-mono text-[10.5px] leading-none">
          {time && <span className="text-low/80">{time}</span>}
          {took}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 pt-1 font-mono text-[10.5px] leading-none">
      {you && (
        <span className="uppercase tracking-[0.1em] text-brand-on-surface">
          {t('director.you')}
        </span>
      )}
      {time && <span className="text-low/80">{time}</span>}
      {took}
    </div>
  );
}

export const ConversationList = forwardRef<
  ConversationListHandle,
  ConversationListProps
>(function ConversationList(
  {
    attempt,
    repos: reposProp = [],
    onAtBottomChange,
    sessionScopeId,
    emptyState,
  },
  ref
) {
  const { t } = useTranslation('common');
  const repos = reposProp;
  const resetAction = useResetProcess(attempt.id, attempt.session?.id);
  const conversationScopeKey = `${attempt.id}:${sessionScopeId ?? attempt.session?.id ?? 'new'}`;
  const [filteredEntries, setFilteredEntries] = useState<DisplayEntry[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasSetupScriptRun, setHasSetupScriptRun] = useState(false);
  const [hasCleanupScriptRun, setHasCleanupScriptRun] = useState(false);
  const [hasRunningProcess, setHasRunningProcess] = useState(false);
  const lastSettledTailStartIndexRef = useRef<number | null>(null);
  const { setEntries, reset } = useEntriesActions();
  const setTokenUsageInfo = useSetTokenUsageInfo();
  const scriptOutputCacheRef = useRef<
    Map<string, { count: number; output: string }>
  >(new Map());
  const scrollOnEntriesChangedRef = useRef<
    ((addType: AddEntryType, isInitialLoad: boolean) => void) | null
  >(null);
  const pendingUpdateRef = useRef<{
    source: ConversationTimelineSource;
    addType: AddEntryType;
    loading: boolean;
    isInitialLoad: boolean;
  } | null>(null);
  // rAF throttle: at most one state update per animation frame.
  // Replaces the previous 100ms trailing debounce which never fired during
  // continuous streaming (upstream rAF in streamJsonPatchEntries reset the
  // timer every ~16ms). TanStack Virtual has no internal batching — unlike
  // Virtuoso — so we need to drive renders explicitly via React state.
  // rAF naturally limits updates to the display refresh rate (~60fps) while
  // ensuring every frame reflects the latest data.
  const rafIdRef = useRef<number | null>(null);
  const planRevealSpacerRef = useRef<HTMLDivElement | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorDeadlineRef = useRef(0);

  // Use ref to access current repos without causing callback recreation
  const reposRef = useRef(repos);
  reposRef.current = repos;

  // Check if any repo has setup or cleanup scripts configured
  const hasSetupScript = repos.some((repo) => repo.setup_script);
  const hasCleanupScript = repos.some((repo) => repo.cleanup_script);

  // Handlers to open script fixer dialog for setup/cleanup scripts
  const handleConfigureSetup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'setup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  const handleConfigureCleanup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'cleanup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  // Determine if configure buttons should be shown
  const canConfigure = repos.length > 0;

  useEffect(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingUpdateRef.current = null;
    scriptOutputCacheRef.current.clear();
    if (planRevealSpacerRef.current) {
      planRevealSpacerRef.current.style.height = '0px';
    }
    setLoading(true);
    setHasSetupScriptRun(false);
    setHasCleanupScriptRun(false);
    setHasRunningProcess(false);
    setFilteredEntries([]);
    setDataVersion(0);
    lastSettledTailStartIndexRef.current = null;
    reset();
  }, [conversationScopeKey, reset]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // ---- TanStack Virtual plumbing ----
  const tanstackScrollRef = useRef<HTMLDivElement | null>(null);
  const assistant = useIsAssistantChat();

  const clearPendingInteractionAnchor = useCallback(() => {
    if (pendingInteractionAnchorFrameRef.current !== null) {
      cancelAnimationFrame(pendingInteractionAnchorFrameRef.current);
      pendingInteractionAnchorFrameRef.current = null;
    }
    pendingInteractionAnchorDeadlineRef.current = 0;
    pendingInteractionAnchorRef.current = null;
  }, []);

  const programmaticScrollDeadlineRef = useRef(0);

  const shouldSuppressInteractionDrivenSizeAdjustment = useCallback(
    () =>
      performance.now() < programmaticScrollDeadlineRef.current ||
      (pendingInteractionAnchorRef.current !== null &&
        performance.now() < pendingInteractionAnchorDeadlineRef.current),
    []
  );

  const runInteractionAnchorCorrection = useCallback(() => {
    pendingInteractionAnchorFrameRef.current = null;

    const anchor = pendingInteractionAnchorRef.current;
    const activeScrollContainer = tanstackScrollRef.current;
    if (!anchor || !activeScrollContainer || !anchor.element.isConnected) {
      clearPendingInteractionAnchor();
      return;
    }

    const currentTop = anchor.element.getBoundingClientRect().top;
    const delta = currentTop - anchor.top;
    if (Math.abs(delta) >= 0.5) {
      activeScrollContainer.scrollTop += delta;
    }

    if (performance.now() < pendingInteractionAnchorDeadlineRef.current) {
      pendingInteractionAnchorFrameRef.current = requestAnimationFrame(
        runInteractionAnchorCorrection
      );
      return;
    }

    clearPendingInteractionAnchor();
  }, [clearPendingInteractionAnchor]);

  const handleConversationClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const trigger = target.closest<HTMLElement>(
        'button, summary, [role="button"], [data-scroll-anchor-target]'
      );
      if (!trigger || trigger.closest('[data-scroll-anchor-ignore]')) return;

      const scrollContainer = tanstackScrollRef.current;
      if (!scrollContainer || !scrollContainer.contains(trigger)) return;

      clearPendingInteractionAnchor();
      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      pendingInteractionAnchorDeadlineRef.current = performance.now() + 250;
      pendingInteractionAnchorFrameRef.current = requestAnimationFrame(
        runInteractionAnchorCorrection
      );
    },
    [clearPendingInteractionAnchor, runInteractionAnchorCorrection]
  );

  const flushPendingUpdate = () => {
    rafIdRef.current = null;
    const pending = pendingUpdateRef.current;
    if (!pending) return;

    const derivedEntries = deriveConversationEntries({
      source: pending.source,
      scriptOutputCache: scriptOutputCacheRef.current,
    });

    setHasSetupScriptRun(derivedEntries.hasSetupScriptRun);
    setHasCleanupScriptRun(derivedEntries.hasCleanupScriptRun);
    setHasRunningProcess(derivedEntries.hasRunningProcess);
    setTokenUsageInfo(derivedEntries.latestTokenUsageInfo);

    const derivedTimeline = deriveConversationTimeline(
      derivedEntries.entries,
      prevEntriesRef.current,
      prevRowsRef.current
    );

    prevEntriesRef.current = derivedTimeline.displayEntries;
    prevRowsRef.current = derivedTimeline.rows;

    setFilteredEntries(derivedTimeline.displayEntries);
    setDataVersion((current) => current + 1);
    setEntries(derivedEntries.entries);

    scrollOnEntriesChangedRef.current?.(pending.addType, pending.isInitialLoad);

    if (loading) {
      setLoading(pending.loading);
    }
  };

  const onTimelineUpdated = (
    source: ConversationTimelineSource,
    addType: AddEntryType,
    newLoading: boolean
  ) => {
    pendingUpdateRef.current = {
      source,
      addType,
      loading: newLoading,
      isInitialLoad: addType === 'initial',
    };

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushPendingUpdate);
    }
  };

  const { isFirstTurn, isLoadingHistory } = useConversationHistory({
    attempt,
    onTimelineUpdated,
    scopeKey: conversationScopeKey,
  });

  const prevEntriesRef = useRef<DisplayEntry[]>([]);
  const prevRowsRef = useRef<ConversationRow[]>([]);
  // Fluke's chat: Fluke's silent replies to app events and every batch of
  // events after the first in a run render nothing, but the virtualizer
  // reserves an estimated height for each, then measures 0: the list keeps
  // resizing and re-pinning to the bottom on open. Drop them here; a run's
  // lines go with the first batch.
  const processesById = useContext(
    ExecutionProcessesContext
  )?.executionProcessesByIdAll;
  const flukeRows = useMemo(() => {
    const rows = prevRowsRef.current;
    const runLines = new Map<ConversationRow, string[]>();
    if (!assistant) return { rows, runLines };
    const kept: ConversationRow[] = [];
    let head: ConversationRow | null = null;
    for (const row of rows) {
      const e = row.entry;
      if (
        e.type === 'NORMALIZED_ENTRY' &&
        e.content.entry_type.type === 'assistant_message' &&
        isSilentReply(e.content.content)
      )
        continue;
      const lines = eventsBatchLines(e);
      if (lines && head && kept[kept.length - 1] === head) {
        runLines.get(head)!.push(...lines);
        continue;
      }
      if (lines) {
        head = row;
        runLines.set(row, [...lines]);
      }
      kept.push(row);
    }
    return { rows: kept, runLines };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows live in a ref refreshed with filteredEntries
  }, [filteredEntries, assistant]);
  const conversationRows = flukeRows.rows;

  // Fluke's chat: history arrives in steps (an empty list, the first
  // entries, then older ones in batches). While the first entries render,
  // the list flips between heights and re-pins to the bottom, which reads as
  // the text scrolling up and down. Older batches only grow it above the
  // pinned bottom, which doesn't show. So keep it invisible until its height
  // stops shrinking for ~12 frames once it started changing (1.2s if it never
  // changes, as in a short conversation; 4s at most), then fade it in.
  const [settledScope, setSettledScope] = useState<string | null>(null);
  const settled = !assistant || settledScope === conversationScopeKey;
  const hasRows = conversationRows.length > 0;
  useEffect(() => {
    if (!assistant || settled || loading || !hasRows) return;
    const el = tanstackScrollRef.current;
    const start = performance.now();
    let lastHeight = -1;
    let changed = false;
    let calmFrames = 0;
    let frame = 0;
    const tick = () => {
      const height = el?.scrollHeight ?? 0;
      if (lastHeight >= 0 && height !== lastHeight) changed = true;
      calmFrames = height < lastHeight ? 0 : calmFrames + 1;
      lastHeight = height;
      const elapsed = performance.now() - start;
      if (
        !el ||
        (calmFrames >= 12 && (changed || elapsed > 1200)) ||
        elapsed > 4000
      ) {
        setSettledScope(conversationScopeKey);
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [assistant, settled, loading, hasRows, conversationScopeKey]);

  // Fluke's chat: which rows open a turn, which runs of app-event batches
  // merge into one telemetry line, and where the latest turn starts.
  const flukeLayout = useMemo(() => {
    const turnStarts = new Set<number>();
    const events = new Map<number, string[]>();
    let latestFrom = Infinity;
    if (!assistant) return { turnStarts, events, latestFrom };
    let pending = true;
    conversationRows.forEach((row, i) => {
      const lines = flukeRows.runLines.get(row);
      if (lines) {
        events.set(i, lines);
        pending = true;
        return;
      }
      const opens = opensAssistantTurn(row.entry);
      if (row.isUserMessage) {
        pending = true;
        latestFrom = Infinity;
      } else if (pending && opens) {
        turnStarts.add(i);
        pending = false;
        latestFrom = i;
      }
    });
    return { turnStarts, events, latestFrom };
  }, [assistant, conversationRows, flukeRows]);

  // Assistant chat: fixed rhythm (28px between turns, 10px inside one);
  // rows that render nothing collapse instead of leaving gaps. Option C:
  // a margin column, the latest turn large, earlier ones faded.
  const renderRow = (row: ConversationRow, index: number) => {
    if (!assistant)
      return renderRowContent(row.entry, attempt, resetAction, repos);
    const { turnStarts, events, latestFrom } = flukeLayout;
    const lines = events.get(index);
    const opensTurn = turnStarts.has(index);
    const isUser = row.isUserMessage && !lines;
    const now = index >= latestFrom;
    // Times come from the process behind the row: a message is its prompt,
    // so it was sent when the process started; Fluke's answer landed when
    // it completed, and that span is how long Fluke took.
    const process = processesById?.[row.entry.executionProcessId];
    const done = process?.completed_at ?? null;
    const timestamp =
      (isUser ? process?.started_at : (done ?? process?.started_at)) ??
      entryTimestamp(row.entry);
    const tookMs =
      opensTurn && process && done
        ? new Date(done).getTime() - new Date(process.started_at).getTime()
        : undefined;
    return (
      <div
        className={cn(
          'grid grid-cols-[56px_minmax(0,1fr)] gap-x-4 px-4 [&:has(>div:last-child>div:empty)]:hidden',
          isUser || opensTurn || lines ? 'pt-7' : 'pt-2.5'
        )}
      >
        <div>
          {(isUser || opensTurn) && (
            <TurnMargin
              timestamp={timestamp}
              you={isUser}
              now={opensTurn && now}
              live={hasRunningProcess}
              tookMs={tookMs}
            />
          )}
        </div>
        <div
          className={cn(
            'min-w-0',
            isUser
              ? 'fluke-tx-you'
              : !lines && (now ? 'fluke-tx-now' : 'fluke-tx-past')
          )}
        >
          {lines ? (
            <FlukeTelemetry lines={lines} />
          ) : (
            renderRowContent(row.entry, attempt, resetAction, repos)
          )}
        </div>
      </div>
    );
  };

  const hasActiveStreamingTurn = useMemo(
    () =>
      hasRunningProcess ||
      conversationRows.some((row) => row.rowFamily === 'loading'),
    [conversationRows, hasRunningProcess]
  );

  const candidateFirstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(
      conversationRows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
      0
    );

    if (!hasActiveStreamingTurn) {
      return firstTailRowIndex;
    }

    for (let index = conversationRows.length - 1; index >= 0; index -= 1) {
      if (conversationRows[index]?.isUserMessage) {
        return Math.min(index, firstTailRowIndex);
      }
    }

    return firstTailRowIndex;
  }, [conversationRows, hasActiveStreamingTurn]);

  const streamingFirstUnvirtualizedRowIndex = useMemo(() => {
    const lastSettledTailStartIndex = lastSettledTailStartIndexRef.current;
    if (lastSettledTailStartIndex == null) {
      return candidateFirstUnvirtualizedRowIndex;
    }

    return Math.min(
      lastSettledTailStartIndex,
      candidateFirstUnvirtualizedRowIndex
    );
  }, [candidateFirstUnvirtualizedRowIndex]);

  useEffect(() => {
    if (!hasActiveStreamingTurn) {
      lastSettledTailStartIndexRef.current =
        candidateFirstUnvirtualizedRowIndex;
    }
  }, [candidateFirstUnvirtualizedRowIndex, hasActiveStreamingTurn]);

  const firstUnvirtualizedRowIndex = hasActiveStreamingTurn
    ? Math.max(
        0,
        streamingFirstUnvirtualizedRowIndex -
          STREAMING_UNVIRTUALIZED_BUFFER_ROWS
      )
    : candidateFirstUnvirtualizedRowIndex;

  const virtualizedRows = useMemo(
    () => conversationRows.slice(0, firstUnvirtualizedRowIndex),
    [conversationRows, firstUnvirtualizedRowIndex]
  );

  const unvirtualizedTailRows = useMemo(
    () => conversationRows.slice(firstUnvirtualizedRowIndex),
    [conversationRows, firstUnvirtualizedRowIndex]
  );

  // Fluke's chat lays rows out its own way (margin column, small type,
  // telemetry lines). The generic estimates, tuned for the task chat, were
  // off by hundreds of px (an events batch was estimated by all its lines
  // but renders as one 44px telemetry line), so the list kept correcting
  // its scroll as rows came into view.
  const estimateFlukeRow = useCallback(
    (row: ConversationRow, width: number | null) => {
      if (!assistant) return undefined;
      if (flukeRows.runLines.has(row)) return 44;
      if (row.rowFamily === 'thinking') return 40;
      if (
        row.rowFamily !== 'user_message' &&
        row.rowFamily !== 'assistant_message'
      )
        return undefined;
      const text =
        row.entry.type === 'NORMALIZED_ENTRY' ? row.entry.content.content : '';
      if (!text || !width) return undefined;
      // Row padding, margin column and gap; ~6.4px per char at 13-14px.
      const charsPerLine = Math.max(
        20,
        Math.floor(Math.max(120, width - 104) / 6.4)
      );
      const lines = text
        .split('\n')
        .reduce(
          (n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)),
          0
        );
      return 36 + lines * 21;
    },
    [assistant, flukeRows]
  );

  const conversationVirtualizer = useConversationVirtualizer({
    rows: virtualizedRows,
    estimateRow: estimateFlukeRow,
    totalRowCount: conversationRows.length,
    scrollContainerRef: tanstackScrollRef,
    onAtBottomChange,
    shouldSuppressSizeAdjustment: shouldSuppressInteractionDrivenSizeAdjustment,
  });

  // NOTE: Do NOT call conversationVirtualizer.virtualizer.measure() when
  // firstUnvirtualizedRowIndex changes. measure() wipes ALL cached item sizes,
  // triggering a massive re-measurement storm and multi-second jitter.
  // TanStack Virtual handles count changes automatically via getItemKey.

  const scrollToAbsoluteIndex = useCallback(
    (
      index: number,
      align: 'start' | 'center' | 'end' = 'start',
      behavior: 'auto' | 'smooth' = 'smooth'
    ): boolean => {
      if (index < 0 || index >= conversationRows.length) return false;

      const scrollEl = tanstackScrollRef.current;
      if (!scrollEl) return false;

      const targetNode = scrollEl.querySelector<HTMLElement>(
        `[data-row-index="${index}"]`
      );

      if (targetNode) {
        let top = targetNode.offsetTop;

        if (align === 'center') {
          top =
            targetNode.offsetTop -
            scrollEl.clientHeight / 2 +
            targetNode.offsetHeight / 2;
        } else if (align === 'end') {
          top =
            targetNode.offsetTop -
            scrollEl.clientHeight +
            targetNode.offsetHeight;
        }

        const requestedTop = Math.max(0, top);
        let maxScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
        const deficit = requestedTop - maxScrollable;

        if (deficit > 1 && align === 'start' && planRevealSpacerRef.current) {
          conversationVirtualizer.releaseBottomLock();
          planRevealSpacerRef.current.style.height = `${Math.ceil(deficit)}px`;
          maxScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
        }

        scrollEl.scrollTo({
          top: Math.min(requestedTop, maxScrollable),
          behavior,
        });
        return true;
      }

      if (index < virtualizedRows.length) {
        conversationVirtualizer.scrollToIndex(index, { align, behavior });
        return true;
      }

      return false;
    },
    [conversationRows.length, conversationVirtualizer, virtualizedRows.length]
  );

  const scrollToBottomAndClearSpacer = useCallback(
    (behavior?: 'auto' | 'smooth') => {
      if (planRevealSpacerRef.current) {
        planRevealSpacerRef.current.style.height = '0px';
      }
      conversationVirtualizer.scrollToBottom(behavior);
    },
    [conversationVirtualizer]
  );

  const scrollExecutor = useScrollCommandExecutor({
    virtualizer: conversationVirtualizer.virtualizer,
    itemCount: conversationRows.length,
    dataVersion,
    checkIsAtBottom: conversationVirtualizer.checkIsAtBottom,
    scrollToBottom: scrollToBottomAndClearSpacer,
    scrollToAbsoluteIndex,
  });
  scrollOnEntriesChangedRef.current = scrollExecutor.onEntriesChanged;

  // Determine if there are entries to show placeholders
  const hasEntries = conversationRows.length > 0;

  // Show placeholders only if script not configured AND not already run AND first turn
  const showSetupPlaceholder =
    !hasSetupScript && !hasSetupScriptRun && hasEntries;
  const showCleanupPlaceholder =
    !hasCleanupScript &&
    !hasCleanupScriptRun &&
    !hasRunningProcess &&
    hasEntries &&
    isFirstTurn;

  // Expose scroll functionality via ref — delegates to TanStack Virtual
  const scrollToPreviousUserMessage = useCallback(() => {
    conversationVirtualizer.releaseBottomLock();

    const scrollEl = tanstackScrollRef.current;
    if (!scrollEl || conversationRows.length === 0) return;

    const containerTop = scrollEl.getBoundingClientRect().top;
    const rowNodes = Array.from(
      scrollEl.querySelectorAll<HTMLElement>('[data-row-index]')
    );

    let firstVisibleIndex = conversationRows.length - 1;

    for (const node of rowNodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= containerTop + 1) continue;
      const indexAttr = node.dataset.rowIndex;
      if (!indexAttr) continue;
      const parsedIndex = Number.parseInt(indexAttr, 10);
      if (!Number.isFinite(parsedIndex)) continue;
      firstVisibleIndex = parsedIndex;
      break;
    }

    const targetIndex = findPreviousUserMessageIndex(
      conversationRows,
      firstVisibleIndex
    );

    if (targetIndex < 0) return;

    programmaticScrollDeadlineRef.current = performance.now() + 1000;

    let attempts = 0;
    const maxAttempts = 6;

    const correctScroll = () => {
      if (attempts >= maxAttempts) return;
      attempts++;

      programmaticScrollDeadlineRef.current = performance.now() + 500;

      const node = scrollEl.querySelector<HTMLElement>(
        `[data-row-index="${targetIndex}"]`
      );
      if (!node) {
        if (attempts === 1) {
          conversationVirtualizer.scrollToIndex(targetIndex, {
            align: 'start',
            behavior: 'auto',
          });
        }
        requestAnimationFrame(correctScroll);
        return;
      }

      const nodeRect = node.getBoundingClientRect();
      const contRect = scrollEl.getBoundingClientRect();
      const delta = nodeRect.top - contRect.top;

      if (Math.abs(delta) < 2) return;

      scrollEl.scrollTop += delta;
      requestAnimationFrame(correctScroll);
    };

    correctScroll();
  }, [
    conversationRows,
    firstUnvirtualizedRowIndex,
    conversationVirtualizer,
    scrollToAbsoluteIndex,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPreviousUserMessage: () => {
        scrollToPreviousUserMessage();
      },
      scrollToBottom: (behavior = 'smooth') => {
        scrollToBottomAndClearSpacer(behavior);
      },
      adjustScrollBy: (delta) => {
        if (Math.abs(delta) < 0.5) return;
        const scrollElement = tanstackScrollRef.current;
        if (!scrollElement) return;
        scrollElement.scrollTop += delta;
      },
      getScrollElement: () => tanstackScrollRef.current,
      scrollToEntryByPatchKey: (patchKey: string) => {
        const targetIndex = conversationRows.findIndex(
          (row) => row.entry.patchKey === patchKey
        );
        if (targetIndex < 0) return;

        const scrollEl = tanstackScrollRef.current;
        if (!scrollEl) return;

        conversationVirtualizer.releaseBottomLock();
        programmaticScrollDeadlineRef.current = performance.now() + 1000;

        // Initial scroll via scrollToAbsoluteIndex which handles both
        // virtualized and unvirtualized (tail) rows correctly.
        scrollToAbsoluteIndex(targetIndex, 'start', 'auto');

        // Correction loop: after the virtualizer lays out the target
        // row, its actual size may differ from the estimate, so we
        // iteratively adjust until the row is at the container top.
        let attempts = 0;
        const maxAttempts = 5;

        const correctScroll = () => {
          if (attempts >= maxAttempts) return;
          attempts++;

          programmaticScrollDeadlineRef.current = performance.now() + 500;

          const node = scrollEl.querySelector<HTMLElement>(
            `[data-row-index="${targetIndex}"]`
          );
          if (!node) {
            requestAnimationFrame(correctScroll);
            return;
          }

          const nodeRect = node.getBoundingClientRect();
          const contRect = scrollEl.getBoundingClientRect();
          const delta = nodeRect.top - contRect.top;

          if (Math.abs(delta) < 2) return;

          scrollEl.scrollTop += delta;
          requestAnimationFrame(correctScroll);
        };

        requestAnimationFrame(correctScroll);
      },
      getVisibleUserMessagePatchKey: () => {
        const scrollEl = tanstackScrollRef.current;
        if (!scrollEl || conversationRows.length === 0) return null;

        const containerTop = scrollEl.getBoundingClientRect().top;
        const rowNodes = Array.from(
          scrollEl.querySelectorAll<HTMLElement>('[data-row-index]')
        );

        let firstVisibleIndex = conversationRows.length - 1;

        for (const node of rowNodes) {
          const rect = node.getBoundingClientRect();
          if (rect.bottom <= containerTop + 1) continue;
          const indexAttr = node.dataset.rowIndex;
          if (!indexAttr) continue;
          const parsedIndex = Number.parseInt(indexAttr, 10);
          if (!Number.isFinite(parsedIndex)) continue;
          firstVisibleIndex = parsedIndex;
          break;
        }

        // Find the nearest user message at or before the first visible index
        for (let i = firstVisibleIndex; i >= 0; i--) {
          if (conversationRows[i].isUserMessage) {
            return conversationRows[i].entry.patchKey;
          }
        }
        return null;
      },
    }),
    [
      conversationRows,
      conversationVirtualizer,
      scrollToAbsoluteIndex,
      scrollToBottomAndClearSpacer,
      scrollToPreviousUserMessage,
    ]
  );

  const showLoader = loading && conversationRows.length === 0;
  const showEmptyState = !loading && conversationRows.length === 0;

  const { virtualItems, totalSize, measureElement } = conversationVirtualizer;

  useEffect(() => {
    return () => {
      clearPendingInteractionAnchor();
    };
  }, [clearPendingInteractionAnchor]);

  return (
    <ApprovalFormProvider>
      <div className="relative h-full overflow-hidden">
        {/* Fluke's empty state is a fixed layer over the list, not part of
            the scroll: nothing to move with the wheel. */}
        {showEmptyState && emptyState && (
          <div className="absolute inset-0 overflow-hidden">{emptyState}</div>
        )}
        {showLoader && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <SpinnerIcon className="size-6 animate-spin text-low" />
          </div>
        )}
        <div
          ref={tanstackScrollRef}
          className={cn(
            'h-full overflow-y-auto scrollbar-none transition-opacity duration-200',
            !settled && 'opacity-0'
          )}
          style={{ overflowAnchor: 'none', contain: 'strict' }}
          onClickCapture={handleConversationClickCapture}
        >
          <div className="pt-2">
            {showSetupPlaceholder && !assistant && (
              <div className="my-base px-double">
                <ChatScriptPlaceholder
                  type="setup"
                  onConfigure={canConfigure ? handleConfigureSetup : undefined}
                />
              </div>
            )}
          </div>

          {/* Not in Fluke's chat: it sits above the rows and its 74px come and
              go while the reader is scrolled up, moving the text. */}
          {isLoadingHistory && !showLoader && !assistant && (
            <div className="flex flex-col items-center gap-2 px-double py-3">
              <div className="flex w-full max-w-md flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-16 animate-pulse rounded-full bg-foreground/10" />
                  <div className="h-2.5 flex-1 animate-pulse rounded-full bg-foreground/[0.06]" />
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="h-2.5 w-24 animate-pulse rounded-full bg-foreground/[0.07]"
                    style={{ animationDelay: '150ms' }}
                  />
                  <div
                    className="h-2.5 w-32 animate-pulse rounded-full bg-foreground/[0.05]"
                    style={{ animationDelay: '150ms' }}
                  />
                </div>
              </div>
              <span className="text-xs text-low">
                {t('conversation.loadingEarlierMessages')}
              </span>
            </div>
          )}

          {showEmptyState && !emptyState && (
            <div className="flex min-h-full items-center justify-center px-double py-12">
              <ChatEmptyState
                title={t('conversation.emptyTitle', {
                  defaultValue: 'Send a message to start the conversation.',
                })}
                description={t('conversation.emptyDescription', {
                  defaultValue:
                    'Your workspace conversation will appear here once a new turn starts.',
                })}
              />
            </div>
          )}

          {virtualizedRows.length > 0 && (
            <div
              style={{
                height: `${totalSize}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualItem) => {
                const row = virtualizedRows[virtualItem.index];
                if (!row) return null;
                return (
                  <div
                    key={row.semanticKey}
                    data-index={virtualItem.index}
                    data-row-index={virtualItem.index}
                    data-semantic-key={row.semanticKey}
                    ref={measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    {renderRow(row, virtualItem.index)}
                  </div>
                );
              })}
            </div>
          )}

          {unvirtualizedTailRows.map((row, tailIndex) => {
            const rowIndex = firstUnvirtualizedRowIndex + tailIndex;
            return (
              <div
                key={row.semanticKey}
                data-row-index={rowIndex}
                data-semantic-key={row.semanticKey}
              >
                {renderRow(row, rowIndex)}
              </div>
            );
          })}

          {/* Plan-reveal spacer: provides extra scroll room so plan-reveal
              can align the plan entry to the top of the viewport. Height is set
              imperatively in scrollToAbsoluteIndex and cleared on scrollToBottom. */}
          <div ref={planRevealSpacerRef} style={{ height: 0 }} />

          {/* Footer placeholder */}
          <div className="pb-2">
            {showCleanupPlaceholder && !assistant && (
              <div className="my-base px-double">
                <ChatScriptPlaceholder
                  type="cleanup"
                  onConfigure={
                    canConfigure ? handleConfigureCleanup : undefined
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </ApprovalFormProvider>
  );
});

export default ConversationList;
