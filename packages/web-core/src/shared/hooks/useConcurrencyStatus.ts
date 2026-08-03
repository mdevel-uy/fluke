import { useQuery } from '@tanstack/react-query';
import {
  executionProcessesApi,
  type ConcurrencyStatus,
} from '@/shared/lib/api';

export const concurrencyKeys = {
  status: ['execution-processes', 'concurrency-status'] as const,
};

/**
 * Polls the backend concurrency semaphore snapshot. Used by the status
 * bar (global slots indicator) and by workspace cards (queue-position
 * badge). Polling — rather than a WebSocket — is enough here: the
 * queue only changes on spawn / process-exit, and the UI already tears
 * down / reconnects on visibility changes via react-query defaults.
 */
export function useConcurrencyStatus() {
  return useQuery<ConcurrencyStatus>({
    queryKey: concurrencyKeys.status,
    queryFn: () => executionProcessesApi.getConcurrencyStatus(),
    // 3s is snappy enough that a user launching 3 attempts in a row
    // sees the queue update between clicks without hammering the API
    // on idle projects.
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
  });
}
