import { ApiError } from '@/shared/lib/api';

// Backend returns a machine-readable error code as the message (e.g.
// `max_review_rounds_reached`) so the UI can localize without shipping the
// English fallback to end users.
const KEYS: Record<string, string> = {
  max_review_rounds_reached: 'sprint.toast.reRequestReviewMaxRounds',
  no_open_pr: 'sprint.toast.reRequestReviewNoOpenPr',
  no_reviewer_assigned: 'sprint.toast.reRequestReviewNoReviewer',
  review_already_in_progress: 'sprint.toast.reRequestReviewInProgress',
  no_changes_requested: 'sprint.toast.reRequestReviewNoChangesRequested',
  no_verdict_to_rerun: 'sprint.toast.reRequestReviewNoChangesRequested',
  pr_head_unchanged: 'sprint.toast.reRequestReviewHeadUnchanged',
};

export function reRequestReviewErrorKey(err: unknown): string {
  const code = err instanceof ApiError && err.message ? err.message : '';
  return KEYS[code] ?? 'sprint.toast.reRequestReviewError';
}
