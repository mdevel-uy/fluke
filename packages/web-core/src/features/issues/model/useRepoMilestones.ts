import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubMilestone } from 'shared/types';
import { repoIssuesApi } from '@/shared/lib/api';

/**
 * GitHub milestones of a repo with their state. A closed milestone is an
 * archived one in the Plan view; archiving and restoring close and reopen it
 * on GitHub, issues untouched.
 */

const keys = {
  byRepo: (repoId: string) => ['repo-milestones', repoId] as const,
};

export function useRepoMilestones(repoId: string | undefined) {
  return useQuery({
    queryKey: keys.byRepo(repoId ?? ''),
    queryFn: () => repoIssuesApi.listMilestones(repoId!),
    enabled: !!repoId,
    staleTime: 60_000,
  });
}

export function useSetMilestoneOpen(repoId: string | undefined) {
  const queryClient = useQueryClient();
  const key = keys.byRepo(repoId ?? '');
  const patch = (number: number, change: Partial<GithubMilestone>) =>
    queryClient.setQueryData<GithubMilestone[]>(key, (prev) =>
      prev?.map((m) => (m.number === number ? { ...m, ...change } : m))
    );

  return useMutation({
    mutationFn: (v: { number: number; open: boolean }) => {
      if (!repoId) throw new Error('repoId required');
      return repoIssuesApi.setMilestoneOpen(repoId, v.number, v.open);
    },
    // Optimistic: the band leaves (or comes back) at once.
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<GithubMilestone[]>(key);
      patch(v.number, { state: v.open ? 'open' : 'closed' });
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(key, ctx.prev);
    },
    onSuccess: (m) => patch(m.number, m),
  });
}
