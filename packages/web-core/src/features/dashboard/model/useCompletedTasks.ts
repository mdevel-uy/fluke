import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { CompletedWorkerTask } from 'shared/types';

export type { CompletedWorkerTask };

// Lives with the other pure helpers; re-exported here for existing callers.
export { parseSqliteUtc } from './dashboardMetrics';

/** Worker tasks completed since local midnight, newest first. */
export function useCompletedTasksToday(): CompletedWorkerTask[] {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';

  const { data = [] } = useQuery({
    queryKey: ['workers', 'completed-tasks', hostId],
    queryFn: async (): Promise<CompletedWorkerTask[]> => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const since = encodeURIComponent(midnight.toISOString());
      const response = await makeLocalApiRequest(
        `${basePath}/workers/completed-tasks?since=${since}`
      );
      if (!response.ok) return [];
      const payload = await response.json();
      return payload?.data?.tasks ?? [];
    },
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  return data;
}

/**
 * Worker tasks completed at or after `since`, newest first. Same endpoint
 * as `useCompletedTasksToday` but with a caller-controlled lower bound so
 * the value-generated panel can render this month's tasks for inline
 * override editing.
 *
 * Returns an empty array while `since` is `null` (typical during hydration).
 */
export function useCompletedTasksSince(since: Date | null): {
  tasks: CompletedWorkerTask[];
  isLoading: boolean;
  refetch: () => void;
} {
  const hostId = useHostId();
  const basePath = hostId ? `/api/host/${hostId}` : '/api';
  const sinceIso = since ? since.toISOString() : null;

  const {
    data = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['workers', 'completed-tasks', 'since', hostId, sinceIso],
    enabled: sinceIso !== null,
    queryFn: async (): Promise<CompletedWorkerTask[]> => {
      const encoded = encodeURIComponent(sinceIso!);
      const response = await makeLocalApiRequest(
        `${basePath}/workers/completed-tasks?since=${encoded}`
      );
      if (!response.ok) return [];
      const payload = await response.json();
      return payload?.data?.tasks ?? [];
    },
    refetchOnWindowFocus: false,
  });

  return { tasks: data, isLoading, refetch: () => void refetch() };
}
