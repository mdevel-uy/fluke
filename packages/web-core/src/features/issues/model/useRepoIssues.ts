import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { repoIssuesApi } from '@/shared/lib/api';
import type { RepoIssue } from '@/features/issues/types';
import { useIssuesRefreshFeedbackStore } from '@/shared/stores/useIssuesRefreshFeedbackStore';
import { repoIssuesKeys } from './repoIssuesKeys';

export function useRepoIssues(repoId: string | undefined) {
  const query = useQuery({
    queryKey: repoId ? repoIssuesKeys.byRepo(repoId) : repoIssuesKeys.all,
    queryFn: () => repoIssuesApi.list(repoId!),
    enabled: !!repoId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Global staleTime is 5min; force a fetch whenever a page (Kanban/Issues)
    // mounts so navigating in never shows stale data.
    refetchOnMount: 'always',
  });

  // Issue #427 · after every successful refresh (polling, focus refetch, or
  // manual sync via setQueryData) publish a transient feedback message to the
  // status bar with how many issue IDs are new vs. the previous snapshot. The
  // initial load and repo switches seed the baseline without emitting so users
  // don't get a message on first mount.
  const previousIdsRef = useRef<Set<string> | null>(null);
  const trackedRepoRef = useRef<string | undefined>(undefined);
  const { data, isError, dataUpdatedAt } = query;

  useEffect(() => {
    if (trackedRepoRef.current !== repoId) {
      trackedRepoRef.current = repoId;
      previousIdsRef.current = null;
    }
    if (!data || isError) return;
    const currentIds = new Set(data.map((i) => i.id));
    const previousIds = previousIdsRef.current;
    if (previousIds !== null) {
      let newCount = 0;
      for (const id of currentIds) {
        if (!previousIds.has(id)) newCount += 1;
      }
      useIssuesRefreshFeedbackStore
        .getState()
        .setFeedback(newCount > 0 ? 'new' : 'none', newCount);
    }
    previousIdsRef.current = currentIds;
  }, [repoId, data, isError, dataUpdatedAt]);

  return query;
}

export function useSyncRepoIssues(repoId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<RepoIssue[]> => {
      if (!repoId) {
        throw new Error('repoId is required to sync issues');
      }
      return repoIssuesApi.sync(repoId);
    },
    onSuccess: (data) => {
      if (!repoId) return;
      queryClient.setQueryData(repoIssuesKeys.byRepo(repoId), data);
    },
  });
}

function updateIssueInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  repoId: string,
  updated: RepoIssue
) {
  queryClient.setQueryData<RepoIssue[]>(
    repoIssuesKeys.byRepo(repoId),
    (prev) =>
      prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev
  );
}

export function useAddIssueLabel(repoId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      issueNumber,
      label,
      color,
    }: {
      issueNumber: number;
      label: string;
      color?: string;
    }) => {
      if (!repoId) throw new Error('repoId required');
      return repoIssuesApi.addLabel(repoId, issueNumber, label, color);
    },
    onSuccess: (updated) => {
      if (!repoId) return;
      updateIssueInCache(queryClient, repoId, updated);
    },
  });
}

export function useRemoveIssueLabel(repoId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      issueNumber,
      labelName,
    }: {
      issueNumber: number;
      labelName: string;
    }) => {
      if (!repoId) throw new Error('repoId required');
      return repoIssuesApi.removeLabel(repoId, issueNumber, labelName);
    },
    onSuccess: (updated) => {
      if (!repoId) return;
      updateIssueInCache(queryClient, repoId, updated);
    },
  });
}

export function useCloseIssue(repoId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueNumber: number) => {
      if (!repoId) throw new Error('repoId required');
      return repoIssuesApi.closeIssue(repoId, issueNumber);
    },
    onSuccess: (updated) => {
      if (!repoId) return;
      updateIssueInCache(queryClient, repoId, updated);
    },
  });
}
