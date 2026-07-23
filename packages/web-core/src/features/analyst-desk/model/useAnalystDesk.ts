import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';

/// Worker tasks created from this screen carry this source; the history list
/// only shows tasks with it, so kanban tasks never mix in.
export const DESK_SOURCE = 'desk';

const MAX_TITLE_LENGTH = 80;

/** Derive the task title from the request text: first line, truncated. */
export function deriveRequestTitle(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].trim();
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export interface CreateDeskRequestInput {
  workerId: string;
  repoId: string;
  prompt: string;
}

export interface CreateDeskRequestResult {
  /** True when the analyst picked up this request immediately. */
  startedNow: boolean;
}

export function useCreateDeskRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      workerId,
      repoId,
      prompt,
    }: CreateDeskRequestInput): Promise<CreateDeskRequestResult> => {
      const task = await workersApi.createTask(workerId, {
        repo_id: repoId,
        title: deriveRequestTitle(prompt),
        prompt,
        source: DESK_SOURCE,
      });

      // Best-effort immediate dispatch. A 409 means the analyst is already
      // working (the request stays queued); any other dispatch error also
      // leaves the request queued, so it is not a failure of the request
      // itself.
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
    },
  });
}

export function useRetryDeskRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workerId, taskId }: { workerId: string; taskId: string }) =>
      workersApi.updateTask(workerId, taskId, { status: 'queued' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}
