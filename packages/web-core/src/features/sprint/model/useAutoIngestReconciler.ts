import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkerResponse } from 'shared/types';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers';
import { useAutoIngestStore } from './useAutoIngestStore';

const RETRY_COOLDOWN_MS = 60_000;

/**
 * While auto-ingest is enabled, no worker should sit idle with a non-empty
 * queue. This covers workers that become free outside the normal completion
 * flow (e.g. a stalled task unblocked by a manual push): whenever polled data
 * shows an idle worker with queued tasks, kick its next task.
 *
 * Failed attempts (in-review cap reached, races) are retried at most once per
 * cooldown window per worker.
 */
export function useAutoIngestReconciler(workers: WorkerResponse[] | undefined) {
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const queryClient = useQueryClient();
  const lastAttemptRef = useRef(new Map<string, number>());
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    if (!autoIngest || !workers) return;
    for (const worker of workers) {
      if (worker.active_workspace_id !== null || worker.queued_count === 0) {
        continue;
      }
      if (inFlightRef.current.has(worker.id)) continue;
      const lastAttempt = lastAttemptRef.current.get(worker.id) ?? 0;
      if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) continue;

      lastAttemptRef.current.set(worker.id, Date.now());
      inFlightRef.current.add(worker.id);
      workersApi
        .startNext(worker.id)
        .then(() =>
          queryClient.invalidateQueries({ queryKey: workersKeys.all })
        )
        .catch(() => {
          // Cap reached or the worker picked something up — retry after the
          // cooldown if it is still idle with a queue.
        })
        .finally(() => inFlightRef.current.delete(worker.id));
    }
  }, [autoIngest, workers, queryClient]);
}
