import type { WorkerResponse } from 'shared/types';

export type WorkerStatus =
  'working' | 'idle' | 'stalled' | 'in_review' | 'waiting' | 'approved';

export interface WorkerStatusFlags {
  needsAttention: boolean;
  inReview: boolean;
  approved: boolean;
  isWaitingApproval: boolean;
}

// Same precedence used by `WorkerCard` for the header dot: attention beats
// waiting beats approved beats in-review beats working, and everything else
// collapses to idle. Kept in a single place so filter chips and the card
// always agree on which bucket a worker falls into.
export function deriveWorkerStatus(
  worker: WorkerResponse,
  flags: WorkerStatusFlags
): WorkerStatus {
  if (flags.needsAttention) return 'stalled';
  if (flags.isWaitingApproval) return 'waiting';
  if (flags.approved) return 'approved';
  if (flags.inReview) return 'in_review';
  if (worker.active_workspace_id !== null) return 'working';
  return 'idle';
}

export const MODEL_BUCKETS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type WorkerModelBucket = (typeof MODEL_BUCKETS)[number];

export function bucketForModel(model?: string): WorkerModelBucket | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  return MODEL_BUCKETS.find((bucket) => normalized.includes(bucket)) ?? null;
}
