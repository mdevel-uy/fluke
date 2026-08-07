import { useMemo } from 'react';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { Worker, WorkerTask } from '@/features/sprint/types';
import { taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';

export type WorkerTaskIndex = {
  taskByWorkspaceId: Map<string, WorkerTask>;
  workerById: Map<string, Worker>;
};

export function buildWorkerTaskIndex(
  workers: Worker[] | undefined,
  tasks: WorkerTask[]
): WorkerTaskIndex {
  const taskByWorkspaceId = new Map<string, WorkerTask>();
  for (const task of tasks) {
    if (task.workspace_id) taskByWorkspaceId.set(task.workspace_id, task);
  }
  const workerById = new Map<string, Worker>();
  for (const worker of workers ?? []) {
    workerById.set(worker.id, worker);
  }
  return { taskByWorkspaceId, workerById };
}

export function useWorkerTaskIndex(
  workers: Worker[] | undefined,
  tasks: WorkerTask[]
): WorkerTaskIndex {
  return useMemo(() => buildWorkerTaskIndex(workers, tasks), [workers, tasks]);
}

/**
 * Worker-task overlay: worker identity, task title, backing issue badge and
 * stalled-task detection. Workspaces without a worker task are returned
 * untouched, so referential equality is preserved for the rest of the list.
 */
export function withWorkerTaskInfo<T extends SidebarWorkspace>(
  list: T[],
  index: WorkerTaskIndex
): T[] {
  return list.map((ws) => {
    const task = index.taskByWorkspaceId.get(ws.id);
    if (!task) return ws;
    const worker = index.workerById.get(task.worker_id);
    return {
      ...ws,
      issueNumber: task.issue_number ?? undefined,
      workerName: worker?.name,
      workerRole: worker?.role ?? undefined,
      workerModel: worker?.model ?? undefined,
      taskTitle: taskDisplayTitle(task),
      // In-progress task whose agent stopped without advancing the task
      // (e.g. a pending push) — surface it as needing attention.
      hasStalledTask:
        task.status === 'in_progress' &&
        !ws.isRunning &&
        !ws.hasPendingApproval &&
        ws.latestProcessStatus !== 'running',
      hasFailedTask: task.status === 'failed',
      hasTaskInReview: task.status === 'in_review',
    };
  });
}
