import { useQuery } from '@tanstack/react-query';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** A worker task that reached a terminal status (mirrors the API response). */
export interface CompletedWorkerTask {
  worker_id: string;
  title: string;
  issue_number: number | null;
  status: 'done' | 'failed' | string;
  /** SQLite UTC datetime: "YYYY-MM-DD HH:MM:SS.SSS" */
  completed_at: string;
}

/** Parse the SQLite UTC datetime returned by the API into a Date. */
export function parseSqliteUtc(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

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
