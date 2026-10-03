import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IssueBlocker } from 'shared/types';
import { issuePhasesApi } from '@/shared/lib/api';

/**
 * Issues of the repo that need a person right now (#694), by number. Shared
 * by the Plan view and its header counter; refreshed every 15 s.
 */
export function useIssueBlockers(repoId: string | undefined) {
  const { data } = useQuery({
    queryKey: ['issue-blockers', repoId],
    queryFn: () => issuePhasesApi.blockers(repoId!),
    enabled: !!repoId,
    refetchInterval: 15_000,
  });
  return useMemo(
    () =>
      new Map<number, IssueBlocker>(
        (data ?? []).map((e) => [e.issue_number, e.blocker])
      ),
    [data]
  );
}
