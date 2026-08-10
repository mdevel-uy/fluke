import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';
import type {
  AgentAction,
  RetryAgentActionsResponse,
} from '@/features/sprint/types';

// Cards render this hook conditionally (only for terminal-ish task states where
// actions actually exist), so the default `enabled` matches that intent — the
// hook is safe to call with a `false` toggle when the task is queued or
// in_progress and no actions have been persisted yet.
export function useAgentActions(
  workerId: string,
  taskId: string,
  enabled: boolean = true
) {
  return useQuery({
    queryKey: workersKeys.taskActions(workerId, taskId),
    queryFn: () =>
      workersApi.listTaskActions<AgentAction[]>(workerId, taskId),
    enabled,
    // Actions are terminal once the drain settles; a slow poll keeps the badge
    // in sync with an out-of-band retry without hammering the server.
    refetchInterval: 30_000,
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
