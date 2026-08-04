import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** A closed GitHub issue, across every repo (mirrors the API response). */
export interface ClosedIssue {
  repo_id: string;
  number: number;
  title: string;
  /** SQLite UTC datetime: "YYYY-MM-DD HH:MM:SS.SSS" */
  closed_at: string;
}

/** Windows offered by the impact panel, in days. */
export const IMPACT_WINDOWS = [7, 30, 90] as const;
export type ImpactWindow = (typeof IMPACT_WINDOWS)[number];

/**
 * Issues closed within the last `days` days, newest first.
 *
 * The endpoint returns raw rows rather than a per-day rollup because days must
 * be bucketed in the viewer's local timezone -- see `bucketClosedIssuesByDay`.
 */
export function useClosedIssues(days: number): {
  issues: ClosedIssue[];
  isLoading: boolean;
} {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';

  const { data = [], isLoading } = useQuery({
    queryKey: ['impact', 'closed-issues', hostId, days],
    queryFn: async (): Promise<ClosedIssue[]> => {
      const response = await makeLocalApiRequest(
        `${basePath}/impact/closed-issues?days=${days}`
      );
      if (!response.ok) return [];
      const payload = await response.json();
      return payload?.data?.issues ?? [];
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });

  return { issues: data, isLoading };
}
