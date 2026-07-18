import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { repoIssuesApi } from '@/shared/lib/api';
import type { RepoIssue } from '@/features/issues/types';
import { repoIssuesKeys } from './repoIssuesKeys';

export function useRepoIssues(repoId: string | undefined) {
  return useQuery({
    queryKey: repoId ? repoIssuesKeys.byRepo(repoId) : repoIssuesKeys.all,
    queryFn: () => repoIssuesApi.list(repoId!),
    enabled: !!repoId,
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
