import { useMutation, useQueryClient } from '@tanstack/react-query';
import { repoIssuesApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';
import { repoIssuesKeys } from './repoIssuesKeys';

/**
 * How long the card keeps saying "merged" before the refetch takes it out of
 * «Pendiente de vos» (design: the result is read on the card itself).
 */
const MERGED_LINGER_MS = 4_000;

/**
 * Merge an approved PR from fluke (#798). The server answers once the PR is
 * merged and the task is done, so a refetch is enough to move the card; on
 * an error the same refetch picks up a state that changed meanwhile
 * (conflicts, CI), and nothing else is touched.
 */
export function useMergePullRequest(repoId: string, prNumber: number) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workersKeys.all });
    void queryClient.invalidateQueries({
      queryKey: repoIssuesKeys.byRepo(repoId),
    });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return useMutation({
    mutationKey: ['merge-pr', repoId, prNumber],
    mutationFn: () => repoIssuesApi.mergePullRequest(repoId, prNumber),
    onSuccess: () => {
      setTimeout(refresh, MERGED_LINGER_MS);
    },
    onError: refresh,
  });
}
