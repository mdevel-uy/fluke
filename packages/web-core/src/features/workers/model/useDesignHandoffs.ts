import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, workersApi } from '@/shared/lib/api';
import { workersKeys } from './workersKeys';
import type { PendingDesignHandoffResponse } from 'shared/types';

export const designHandoffsKeys = {
  pending: ['design-handoffs', 'pending'] as const,
};

/**
 * Finished designer deliverables no analyst has taken yet. Shared by the
 * Analyst Desk picker and any future board surface; polled so a design that
 * finishes while the Desk is open shows up without a manual refresh.
 */
export function usePendingDesignHandoffs(enabled = true) {
  return useQuery<PendingDesignHandoffResponse[]>({
    queryKey: designHandoffsKeys.pending,
    queryFn: () => workersApi.listPendingDesignHandoffs(),
    enabled,
    refetchInterval: 60_000,
  });
}

export interface CreateDesignHandoffInput {
  /** Designer task whose deliverable is being handed off. */
  sourceTaskId: string;
  /** Target analyst worker. */
  workerId: string;
  /** Optional PM guidance layered on top of the server-side template. */
  note?: string;
  /** Entry point: designer done card or Analyst Desk picker. */
  source: 'kanban';
}

export interface CreateDesignHandoffResult {
  /** True when the analyst picked up the handoff task immediately. */
  startedNow: boolean;
}

/**
 * Both handoff entry points (designer card, Desk picker) converge on this
 * mutation so there is exactly one handoff mechanic client-side too. The
 * prompt is composed server-side; a 409 means the design was already taken.
 */
export function useCreateDesignHandoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sourceTaskId,
      workerId,
      note,
      source,
    }: CreateDesignHandoffInput): Promise<CreateDesignHandoffResult> => {
      const task = await workersApi.createDesignHandoff({
        source_task_id: sourceTaskId,
        worker_id: workerId,
        ...(note ? { note } : {}),
        source,
      });

      // Best-effort immediate dispatch, mirroring the Desk request flow: a
      // failure here just leaves the task queued, which is not a handoff
      // failure.
      try {
        const started = await workersApi.startNext(workerId);
        return { startedNow: started.id === task.id };
      } catch (err) {
        if (err instanceof ApiError) return { startedNow: false };
        throw err;
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workersKeys.all });
      void queryClient.invalidateQueries({
        queryKey: designHandoffsKeys.pending,
      });
    },
  });
}
