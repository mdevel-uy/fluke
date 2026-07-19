import type { WorkerResponse, WorkerTaskResponse } from 'shared/types';

export type Worker = WorkerResponse;

export type WorkerTask = WorkerTaskResponse;

export type SprintColumnStatus =
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'done';
