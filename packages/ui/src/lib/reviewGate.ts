// Why an in-review PR does (or does not yet) have a reviewer on it. One
// vocabulary for every surface that shows review state — the workspace aside,
// the sidebar row and the worker cards — so they never disagree.
//
// Derived only from data the pr_monitor already persists (CI rollup + review
// activity). Dispatch gates that leave no trace yet (reviewer without PAT,
// in_review cap, infra backoff) fall under `awaiting`.

export type ReviewGate =
  | 'approved'
  | 'escalated'
  | 'addressed'
  | 'changes_requested'
  | 'author_fixing'
  | 'reviewing'
  | 'queued'
  | 'ci_failing'
  | 'waiting_ci'
  | 'awaiting';

export interface ReviewGateInput {
  /** Worker task verdict: "approved" | "changes_requested" */
  reviewResult?: string | null;
  /** Review-loop activity on the open PR: "queued" | "running" */
  reviewActivity?: string;
  /** CI rollup of the open PR: "passing" | "failing" | "pending" | "none" | "unknown" */
  ciStatus?: string;
  /** A reviewer worker task is in progress on this PR */
  reviewerWorking?: boolean;
  /** The PR author's agent is running on the workspace (remediation / CI fix) */
  authorWorking?: boolean;
  /** Every review round is spent: the loop no longer reviews nor fixes */
  roundsExhausted?: boolean;
}

// Precedence is "what is happening right now" first: the stored verdict goes
// stale the moment the author pushes a fix (it stays `changes_requested` until
// the next verdict), so live activity and CI must win over it.
export function reviewGate(input: ReviewGateInput): ReviewGate {
  if (input.authorWorking) return 'author_fixing';
  if (input.reviewerWorking || input.reviewActivity === 'running') {
    return 'reviewing';
  }
  if (input.reviewActivity === 'queued') return 'queued';
  if (input.reviewResult === 'approved') return 'approved';
  // Changes still requested after the last round: the orchestrator stopped
  // (no re-review, no author fix), so nothing moves until a human decides.
  if (input.roundsExhausted && input.reviewResult === 'changes_requested') {
    return 'escalated';
  }
  // No rounds left and no verdict standing: the author fixed and marked the
  // requested changes addressed (the orchestrator clears the verdict), and no
  // re-review will come — validating the fix is the human's call.
  if (input.roundsExhausted && !input.reviewResult) return 'addressed';
  // The review is only dispatched on green CI (issue #367): pending or red CI
  // is the reason nobody is reviewing yet.
  if (input.ciStatus === 'failing') return 'ci_failing';
  if (input.ciStatus === 'pending') return 'waiting_ci';
  if (input.reviewResult === 'changes_requested') return 'changes_requested';
  return 'awaiting';
}

type T = (key: string, options?: Record<string, unknown>) => string;

export function reviewGateLabel(gate: ReviewGate, t: T): string {
  switch (gate) {
    case 'approved':
      return t('common:workspaces.reviewGate.approved', {
        defaultValue: 'Approved',
      });
    case 'escalated':
      return t('common:workspaces.reviewGate.escalated', {
        defaultValue: 'Review rounds exhausted',
      });
    case 'addressed':
      return t('common:workspaces.reviewGate.addressed', {
        defaultValue: 'Changes addressed',
      });
    case 'changes_requested':
      return t('common:workspaces.reviewGate.changesRequested', {
        defaultValue: 'Changes requested',
      });
    case 'author_fixing':
      return t('common:workspaces.reviewGate.authorFixing', {
        defaultValue: 'Author fixing',
      });
    case 'reviewing':
      return t('common:workspaces.reviewGate.reviewing', {
        defaultValue: 'Reviewer working…',
      });
    case 'queued':
      return t('common:workspaces.reviewGate.queued', {
        defaultValue: 'Queued for review',
      });
    case 'ci_failing':
      return t('common:workspaces.reviewGate.ciFailing', {
        defaultValue: 'CI failing',
      });
    case 'waiting_ci':
      return t('common:workspaces.reviewGate.waitingCi', {
        defaultValue: 'Waiting for CI',
      });
    case 'awaiting':
      return t('common:workspaces.reviewGate.awaiting', {
        defaultValue: 'Awaiting review',
      });
  }
}

/** One-line explanation of what happens next, for the states that block. */
export function reviewGateHint(gate: ReviewGate, t: T): string | null {
  if (gate === 'addressed') {
    return t('common:workspaces.reviewGate.addressedHint', {
      defaultValue:
        'The author pushed the fix and marked the requested changes resolved on GitHub. No review rounds left: validate it and merge.',
    });
  }
  if (gate === 'escalated') {
    return t('common:workspaces.reviewGate.escalatedHint', {
      defaultValue:
        'The reviewer still requests changes after the last round. Automation stopped: merge, fix it by hand, or send the author a follow-up.',
    });
  }
  if (gate === 'waiting_ci') {
    return t('common:workspaces.reviewGate.waitingCiHint', {
      defaultValue:
        'A reviewer picks it up as soon as every check is green. Nothing to do.',
    });
  }
  if (gate === 'ci_failing') {
    return t('common:workspaces.reviewGate.ciFailingHint', {
      defaultValue:
        'The review starts once CI is green again. A fix task goes to the author.',
    });
  }
  return null;
}

/** Text + border classes for the gate's pill (semantic tones of the theme). */
export function reviewGateToneClass(gate: ReviewGate): string {
  switch (gate) {
    case 'approved':
      return 'border-success/45 text-success';
    case 'changes_requested':
    case 'waiting_ci':
    case 'escalated':
      return 'border-warning/45 text-warning';
    case 'ci_failing':
      return 'border-error/45 text-error';
    case 'reviewing':
    case 'author_fixing':
      return 'animate-pulse border-info/45 text-info';
    case 'queued':
    case 'addressed':
      return 'border-info/45 text-info';
    case 'awaiting':
      return 'border-border-strong text-low';
  }
}
