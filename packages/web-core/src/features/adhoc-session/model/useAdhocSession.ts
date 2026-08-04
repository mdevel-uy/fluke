import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session, WorkspaceContext } from 'shared/types';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

/**
 * State machine for the ad-hoc chat panel:
 * 1. Read the selected repo (fallback to first repo in the account).
 * 2. Resolve the scratch workspace for that repo (lazily created backend-side).
 * 3. Load the workspace's sessions and expose the most recently used as
 *    `selectedSession`. "Nueva sesión" creates a fresh session under the same
 *    scratch workspace and switches to it — history stays queryable but the
 *    chat surface renders the new one.
 *
 * Everything is disabled unless `enabled` is true so the panel doesn't fire
 * requests while it's collapsed off-screen.
 */

export const adhocScratchKeys = {
  byRepo: (repoId: string | undefined, hostId: string | null = null) =>
    [
      'adhocScratchWorkspace',
      getHostRequestScopeQueryKey(hostId),
      repoId,
    ] as const,
};

interface UseAdhocSessionOptions {
  enabled: boolean;
}

interface UseAdhocSessionResult {
  repoId: string | undefined;
  workspaceContext: WorkspaceContext | undefined;
  workspaceId: string | undefined;
  sessions: Session[];
  selectedSession: Session | undefined;
  selectedSessionId: string | undefined;
  selectSession: (sessionId: string) => void;
  startNewSession: () => Promise<void>;
  isStartingNewSession: boolean;
  isLoading: boolean;
  isReady: boolean;
  error: Error | null;
  retry: () => void;
}

export function useAdhocSession(
  options: UseAdhocSessionOptions
): UseAdhocSessionResult {
  const { enabled } = options;
  const hostId = useHostId();
  const queryClient = useQueryClient();

  const { repos, isLoadingRepos } = useRepos();
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);

  const repoId = useMemo(() => {
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id;
  }, [storedRepoId, repos]);

  const scratchQuery = useQuery<WorkspaceContext, Error>({
    queryKey: adhocScratchKeys.byRepo(repoId, hostId),
    queryFn: () => workspacesApi.getScratchByRepo(repoId!),
    enabled: enabled && !!repoId,
    staleTime: 60_000,
  });

  const workspaceId = scratchQuery.data?.workspace.id;

  const sessionsQuery = useQuery<Session[], Error>({
    queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => sessionsApi.getByWorkspace(workspaceId!),
    enabled: enabled && !!workspaceId,
  });

  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data]
  );

  // Explicit selection lets "Nueva sesión" pin the freshly created session
  // even before the sessions query refetches — otherwise the auto-select
  // effect would keep pointing at the previous "most recent" until the
  // network round-trip finished.
  const [pinnedSessionId, setPinnedSessionId] = useState<string | undefined>(
    undefined
  );

  // Drop the pin when the workspace changes so we don't hold on to a session
  // id that belongs to a different scratch workspace.
  useEffect(() => {
    setPinnedSessionId(undefined);
  }, [workspaceId]);

  // Drop the pin when the target session disappears (e.g. deleted elsewhere).
  useEffect(() => {
    if (
      pinnedSessionId &&
      sessions.length > 0 &&
      !sessions.some((s) => s.id === pinnedSessionId)
    ) {
      setPinnedSessionId(undefined);
    }
  }, [pinnedSessionId, sessions]);

  const selectedSessionId = pinnedSessionId ?? sessions[0]?.id;
  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    setPinnedSessionId(sessionId);
  }, []);

  const newSessionMutation = useMutation<Session, Error, void>({
    mutationFn: async () => {
      if (!workspaceId) {
        throw new Error('No scratch workspace resolved');
      }
      return sessionsApi.create({ workspace_id: workspaceId });
    },
    onSuccess: async (session) => {
      setPinnedSessionId(session.id);
      await queryClient.invalidateQueries({
        queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
      });
    },
  });

  const startNewSession = useCallback(async () => {
    await newSessionMutation.mutateAsync();
  }, [newSessionMutation]);

  const retry = useCallback(() => {
    if (scratchQuery.isError) {
      void scratchQuery.refetch();
    } else if (sessionsQuery.isError) {
      void sessionsQuery.refetch();
    }
  }, [scratchQuery, sessionsQuery]);

  const isLoading =
    enabled &&
    (isLoadingRepos ||
      (!!repoId && scratchQuery.isLoading) ||
      (!!workspaceId && sessionsQuery.isLoading));

  const isReady =
    enabled &&
    !!repoId &&
    !!workspaceId &&
    !!selectedSession &&
    !scratchQuery.isError &&
    !sessionsQuery.isError;

  const error =
    (scratchQuery.error as Error | null) ??
    (sessionsQuery.error as Error | null) ??
    null;

  return {
    repoId,
    workspaceContext: scratchQuery.data,
    workspaceId,
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    startNewSession,
    isStartingNewSession: newSessionMutation.isPending,
    isLoading: !!isLoading,
    isReady,
    error,
    retry,
  };
}
