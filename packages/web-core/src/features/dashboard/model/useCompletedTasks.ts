import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { CompletedWorkerTask } from 'shared/types';

export type { CompletedWorkerTask };

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
