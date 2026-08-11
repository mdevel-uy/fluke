import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** A worker task that reached `done`, across every repo (mirrors the API). */
export interface ResolvedTask {
  repo_id: string;
  /** GitHub issue the task was spawned from, when there is one. */
  issue_number: number | null;
  title: string;
  /** SQLite UTC datetime: "YYYY-MM-DD HH:MM:SS.SSS" */
  completed_at: string;
}

/** Windows offered by the impact panel, in days. */
export const IMPACT_WINDOWS = [7, 30, 90] as const;
export type ImpactWindow = (typeof IMPACT_WINDOWS)[number];

/**
 * Worker tasks completed within the last `days` days, newest first.
 *
 * The endpoint returns raw rows rather than a per-day rollup because days must
 * be bucketed in the viewer's local timezone -- see `bucketResolvedTasksByDay`.
 */
export function useResolvedTasks(days: number): {
  tasks: ResolvedTask[];
  isLoading: boolean;
} {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';

  const { data = [], isLoading } = useQuery({
    queryKey: ['impact', 'resolved-tasks', hostId, days],
    queryFn: async (): Promise<ResolvedTask[]> => {
      const response = await makeLocalApiRequest(
        `${basePath}/impact/resolved-tasks?days=${days}`
      );
      if (!response.ok) return [];
      const payload = await response.json();
      return payload?.data?.tasks ?? [];
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });

  return { tasks: data, isLoading };
}
