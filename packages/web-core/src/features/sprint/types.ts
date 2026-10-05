import type { WorkerResponse, WorkerTaskResponse } from 'shared/types';

export type Worker = WorkerResponse;

// Extends the generated type with fields added on branches before
// shared/types.ts is regenerated. All fields are additive and remain
// valid after regeneration.
export type WorkerTask = WorkerTaskResponse & {
  skills?: string[];
  pr_mergeable?: string | null;
  pr_number?: number | null;
  pr_ci_status?: string | null;
  source?: string;
  review_result?: string | null;
  loop_state?: string | null;
  failure_reason?: string | null;
};

export type SprintColumnStatus =
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'done';

// Read-only projection served by
// GET /api/workers/{worker_id}/tasks/{task_id}/actions. Kept in sync with
// `AgentActionResponse` in crates/server/src/routes/workers.rs; not exported
// via ts-rs to avoid churning shared/types.ts for a small, additive shape.
export type AgentActionStatus = 'pending' | 'done' | 'failed' | 'skipped';

export type AgentAction = {
  seq: number;
  kind: string;
  status: AgentActionStatus;
  last_error: string | null;
  result_number: number | null;
  result_url: string | null;
};

export type RetryAgentActionsResponse = {
  done: number;
  failed: number;
  pending_remaining: number;
};
