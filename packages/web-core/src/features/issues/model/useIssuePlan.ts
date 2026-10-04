import { useQuery } from '@tanstack/react-query';
import { issuePhasesApi } from '@/shared/lib/api';

/** Phases of one issue (#686), refreshed every 15 s while the page is open. */
export function useIssuePlan(repoId: string | undefined, issueNumber: number) {
  return useQuery({
    queryKey: ['issue-plan', repoId, issueNumber],
    queryFn: () => issuePhasesApi.get(repoId!, issueNumber),
    enabled: !!repoId && Number.isInteger(issueNumber),
    refetchInterval: 15_000,
    // Live view: refetch on mount instead of showing the cached snapshot.
    staleTime: 0,
  });
}
