import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';
import type {
  AgentAction,
  RetryAgentActionsResponse,
} from '@/features/sprint/types';

// The default is `enabled: false` on purpose: mounting a poller on every card
// of the kanban board would fan out to N GETs for tasks that never declared a
// single agent action (which is the majority today). Callers must decide when
// a task is plausible-enough to have actions before flipping this to `true`
// — e.g. a task in `failed` state after the finish hook drained the outbox.
//
// Refetch cadence is intentionally on-focus-only: actions are terminal once
// the drain settles, and the retry mutation invalidates this cache directly,
// so there is no need for a background poll to keep the badge honest.
export function useAgentActions(
  workerId: string,
  taskId: string,
  enabled: boolean = false
) {
  return useQuery({
    queryKey: workersKeys.taskActions(workerId, taskId),
    queryFn: () =>
      workersApi.listTaskActions<AgentAction[]>(workerId, taskId),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function useRetryAgentActions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workerId,
      taskId,
    }: {
      workerId: string;
      taskId: string;
    }) =>
      workersApi.retryTaskActions<RetryAgentActionsResponse>(workerId, taskId),
    // The retry mutates action rows AND may flip the task's own status back to
    // `failed` when a definitive failure resurfaces during the drain — refresh
    // both caches so the badge and the card status update together.
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({
        queryKey: workersKeys.taskActions(
          variables.workerId,
          variables.taskId
        ),
      });
      queryClient.invalidateQueries({
        queryKey: workersKeys.tasks(variables.workerId),
      });
    },
  });
}
