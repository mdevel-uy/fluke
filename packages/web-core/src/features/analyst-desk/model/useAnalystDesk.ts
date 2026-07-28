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
  /**
   * Attachments already uploaded via `attachmentsApi.upload` — the page owns
   * the upload lifecycle so it can render per-file progress and keep any
   * successful uploads visible if a partial failure aborts the submit.
   */
  attachmentIds?: string[];
  /**
   * Skill names to attach to this request. The backend appends a
   * `Usá el skill /<name>...` instruction per skill to the stored prompt.
   */
  skills?: string[];
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
      attachmentIds,
      skills,
    }: CreateDeskRequestInput): Promise<CreateDeskRequestResult> => {
      // Backend contract (issue #161): `attachment_ids` is optional; the
      // shared `CreateWorkerTaskRequest` type has not been regenerated yet,
      // so we widen the payload locally to include it.
      const payload = {
        repo_id: repoId,
        title: deriveRequestTitle(prompt),
        prompt,
        source: DESK_SOURCE,
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(attachmentIds && attachmentIds.length > 0
          ? { attachment_ids: attachmentIds }
          : {}),
      } as Parameters<typeof workersApi.createTask>[1];
      const task = await workersApi.createTask(workerId, payload);

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

/**
 * Cancels an in-progress or in-review desk request: stops the container and
 * removes the task record. The backend's `try_stop` is best-effort, so this
 * succeeds even if the container was already gone.
 */
export function useCancelDeskRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workerId, taskId }: { workerId: string; taskId: string }) =>
      workersApi.cancelTask(workerId, taskId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

/** Removes a queued or failed desk request from the analyst's task list. */
export function useRemoveDeskRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workerId, taskId }: { workerId: string; taskId: string }) =>
      workersApi.deleteTask(workerId, taskId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}
