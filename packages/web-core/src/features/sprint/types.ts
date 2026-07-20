import type { WorkerResponse, WorkerTaskResponse } from 'shared/types';

export type Worker = WorkerResponse;

export type WorkerTask = WorkerTaskResponse & { pr_mergeable?: string | null };

export type SprintColumnStatus =
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'done';
