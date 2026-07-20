import type { WorkerResponse, WorkerTaskResponse } from 'shared/types';

export type Worker = WorkerResponse;

// Extends the generated type with fields added on branches before
// shared/types.ts is regenerated. Both fields are additive and remain
// valid after regeneration.
export type WorkerTask = WorkerTaskResponse & {
  skills?: string[];
  pr_mergeable?: string | null;
};

export type SprintColumnStatus =
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'done';
