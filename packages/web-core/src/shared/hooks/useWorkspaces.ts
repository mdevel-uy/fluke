import { useCallback, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type {
  WorkspaceWithStatus,
  WorkspaceSummary,
  WorkspaceSummaryResponse,
  ApiResponse,
} from 'shared/types';

// UI-specific workspace type for sidebar display
export interface SidebarWorkspace {
  id: string;
  name: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  description: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  prNumber?: number;
  prUrl?: string;
  prMergeable?: string;
  /** CI rollup of the open PR: "passing" | "failing" | "pending" | "none" | "unknown" */
  prCiStatus?: string;
  contextUsage?: {
    totalTokens: number;
    contextWindow: number;
    /** Anthropic token breakdown fields (Claude only, `null` for other providers). */
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    cacheReadInputTokens?: number | null;
  };
  /** The agent's most recent tool activity (e.g. "Edit: `src/foo.rs`") */
  latestActivity?: string;
  /** When the latest PR was recorded (for the dashboard activity feed) */
  prCreatedAt?: string;
  /** When the latest PR was merged, if it was */
  prMergedAt?: string;
  /** Review-loop activity on the open PR: "queued" | "running" */
  prReviewActivity?: string;
  /** GitHub issue backing this workspace's worker task, if any */
  issueNumber?: number;
  /**
   * Orchestrator is publishing this developer worker's PR (push + adopt/create
   * + on_pr_open). During this window the task is still `in_progress` in the
   * DB but the agent has already stopped — the flag suppresses the stalled
   * badge that would otherwise flash before the task turns `in_review`
   * (issue #494).
   */
  isFinalizing?: boolean;
  /** Worker task is in progress but the agent is no longer running */
  hasStalledTask?: boolean;
  /** Backing worker task ended in failed status */
  hasFailedTask?: boolean;
  /** Backing worker task is in review status (PR open, awaiting reviewer) */
  hasTaskInReview?: boolean;
  /** Backing worker task was approved by the reviewer, PR still open pending merge */
  hasTaskApproved?: boolean;
  /** When the latest coding-agent process started (for elapsed time) */
  latestProcessStartedAt?: string;
  /** Name of the worker that owns this workspace, if any */
  workerName?: string;
  /** Role of the owning worker: developer | analyst | reviewer */
  workerRole?: string;
  /** Model configured for the owning worker, if any */
  workerModel?: string;
  /** Display title of the worker task backing this workspace */
  taskTitle?: string;
}

// Keep the old export name for backwards compatibility
export type Workspace = SidebarWorkspace;

export interface UseWorkspacesResult {
  workspaces: SidebarWorkspace[];
  archivedWorkspaces: SidebarWorkspace[];
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

// State shape from the WebSocket stream
type WorkspacesState = {
  workspaces: Record<string, WorkspaceWithStatus>;
};

// Transform WorkspaceWithStatus to SidebarWorkspace, optionally merging summary data
function toSidebarWorkspace(
  ws: WorkspaceWithStatus,
  summary?: WorkspaceSummary
): SidebarWorkspace {
  // Fields added on this branch before shared/types.ts is regenerated
  // (same pattern as pr_mergeable below).
  const extendedSummary = summary as
    | (typeof summary & {
        latest_context_usage?: {
          total_tokens: number;
          model_context_window: number;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        } | null;
        latest_process_started_at?: string | null;
        pr_ci_status?: string | null;
        latest_activity?: string | null;
        pr_created_at?: string | null;
        pr_merged_at?: string | null;
        pr_review_activity?: string | null;
        is_finalizing?: boolean | null;
      })
    | undefined;
  const contextUsage = extendedSummary?.latest_context_usage;

  return {
    id: ws.id,
    name: ws.name ?? ws.branch, // Use name if available, fallback to branch
    branch: ws.branch,
    createdAt: ws.created_at,
    updatedAt: ws.updated_at,
    description: '',
    // Use real stats from summary if available
    filesChanged: summary?.files_changed ?? undefined,
    linesAdded: summary?.lines_added ?? undefined,
    linesRemoved: summary?.lines_removed ?? undefined,
    // Real data from stream
    isRunning: ws.is_running,
    isPinned: ws.pinned,
    isArchived: ws.archived,
    // Additional data from summary
    hasPendingApproval: summary?.has_pending_approval,
    hasRunningDevServer: summary?.has_running_dev_server,
    hasUnseenActivity: summary?.has_unseen_turns,
    latestProcessCompletedAt: summary?.latest_process_completed_at ?? undefined,
    latestProcessStatus: summary?.latest_process_status ?? undefined,
    prStatus: summary?.pr_status ?? undefined,
    prNumber:
      summary?.pr_number != null ? Number(summary.pr_number) : undefined,
    prUrl: summary?.pr_url ?? undefined,
    prMergeable:
      (
        summary as
          | (typeof summary & { pr_mergeable?: string | null })
          | undefined
      )?.pr_mergeable ?? undefined,
    contextUsage: contextUsage
      ? {
          totalTokens: contextUsage.total_tokens,
          contextWindow: contextUsage.model_context_window,
          inputTokens: contextUsage.input_tokens ?? null,
          outputTokens: contextUsage.output_tokens ?? null,
          cacheCreationInputTokens:
            contextUsage.cache_creation_input_tokens ?? null,
          cacheReadInputTokens: contextUsage.cache_read_input_tokens ?? null,
        }
      : undefined,
    latestProcessStartedAt:
      extendedSummary?.latest_process_started_at ?? undefined,
    prCiStatus: extendedSummary?.pr_ci_status ?? undefined,
    latestActivity: extendedSummary?.latest_activity ?? undefined,
    prCreatedAt: extendedSummary?.pr_created_at ?? undefined,
    prMergedAt: extendedSummary?.pr_merged_at ?? undefined,
    prReviewActivity: extendedSummary?.pr_review_activity ?? undefined,
    isFinalizing: extendedSummary?.is_finalizing ?? undefined,
  };
}

export const workspaceKeys = {
  all: ['workspaces'] as const,
};

// workspaceSummaryKeys is imported from @/shared/hooks/workspaceSummaryKeys

// Fetch workspace summaries from the API by archived status
async function fetchWorkspaceSummariesByArchived(
  archived: boolean,
  hostId: string | null
): Promise<Map<string, WorkspaceSummary>> {
  try {
    const basePath = hostId ? `/api/host/${hostId}` : '/api';
    const response = await makeLocalApiRequest(
      `${basePath}/workspaces/summaries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      }
    );

    if (!response.ok) {
      console.warn('Failed to fetch workspace summaries:', response.status);
      return new Map();
    }

    const data: ApiResponse<WorkspaceSummaryResponse> = await response.json();
    if (!data.success || !data.data?.summaries) {
      return new Map();
    }

    const map = new Map<string, WorkspaceSummary>();
    for (const summary of data.data.summaries) {
      map.set(summary.workspace_id, summary);
    }
    return map;
  } catch (err) {
    console.warn('Error fetching workspace summaries:', err);
    return new Map();
  }
}

export function useWorkspaces(): UseWorkspacesResult {
  const hostId = useHostId();

  // Two separate WebSocket connections: one for active, one for archived
  // No limit param - we fetch all and slice on frontend so backfill works when archiving
  const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
  const activeEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=false`;
  const archivedEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=true`;

  const initialData = useCallback(
    (): WorkspacesState => ({ workspaces: {} }),
    []
  );

  const {
    data: activeData,
    isConnected: activeIsConnected,
    isInitialized: activeIsInitialized,
    error: activeError,
  } = useJsonPatchWsStream<WorkspacesState>(activeEndpoint, true, initialData);

  const {
    data: archivedData,
    isConnected: archivedIsConnected,
    isInitialized: archivedIsInitialized,
    error: archivedError,
  } = useJsonPatchWsStream<WorkspacesState>(
    archivedEndpoint,
    true,
    initialData
  );

  // Wait for both streams to be initialized before fetching summaries
  // Fetch summaries for active workspaces
  const { data: activeSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(false, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(false, hostId),
      enabled: activeIsInitialized,
      staleTime: 1000,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      placeholderData: keepPreviousData,
    });

  // Fetch summaries for archived workspaces
  const { data: archivedSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(true, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(true, hostId),
      enabled: archivedIsInitialized,
      staleTime: 1000,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      placeholderData: keepPreviousData,
    });

  const workspaces = useMemo(() => {
    if (!activeData?.workspaces) return [];
    return Object.values(activeData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) => toSidebarWorkspace(ws, activeSummaries.get(ws.id)));
  }, [activeData, activeSummaries]);

  const archivedWorkspaces = useMemo(() => {
    if (!archivedData?.workspaces) return [];
    return Object.values(archivedData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) => toSidebarWorkspace(ws, archivedSummaries.get(ws.id)));
  }, [archivedData, archivedSummaries]);

  // isLoading is true when we haven't received initial data from either stream
  const isLoading = !activeIsInitialized || !archivedIsInitialized;

  // Combined connection status
  const isConnected = activeIsConnected && archivedIsConnected;

  // Combined error (show first error if any)
  const error = activeError || archivedError;

  return {
    workspaces,
    archivedWorkspaces,
    isLoading,
    isConnected,
    error,
  };
}
