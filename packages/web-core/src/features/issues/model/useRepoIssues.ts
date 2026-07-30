import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { repoIssuesApi } from '@/shared/lib/api';
import type { RepoIssue } from '@/features/issues/types';
import { repoIssuesKeys } from './repoIssuesKeys';

export function useRepoIssues(repoId: string | undefined) {
  return useQuery({
    queryKey: repoId ? repoIssuesKeys.byRepo(repoId) : repoIssuesKeys.all,
    queryFn: () => repoIssuesApi.list(repoId!),
    enabled: !!repoId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Global QueryClient defaults staleTime to 5 minutes, so navigating back
    // to Kanban/Issues within that window served stale cache without hitting
    // the API. Force a refetch on every mount so users see fresh data as
    // soon as the page opens.
    refetchOnMount: 'always',
  });
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
