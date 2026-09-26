import { describe, expect, it } from 'vitest';
import { reviewGate } from '@vibe/ui/lib/reviewGate';

describe('reviewGate', () => {
  it('explains the wait with the CI state when nobody reviews yet', () => {
    expect(reviewGate({ ciStatus: 'pending' })).toBe('waiting_ci');
    expect(reviewGate({ ciStatus: 'failing' })).toBe('ci_failing');
    expect(reviewGate({ ciStatus: 'passing' })).toBe('awaiting');
    expect(reviewGate({})).toBe('awaiting');
  });

  it('prefers review activity over CI', () => {
    expect(
      reviewGate({ ciStatus: 'pending', reviewActivity: 'running' })
    ).toBe('reviewing');
    expect(reviewGate({ ciStatus: 'pending', reviewerWorking: true })).toBe(
      'reviewing'
    );
    expect(reviewGate({ ciStatus: 'failing', reviewActivity: 'queued' })).toBe(
      'queued'
    );
  });

  it('live activity wins over a stale changes_requested verdict', () => {
    const stale = { reviewResult: 'changes_requested' };
    // PR #585: author running the remediation after the second request.
    expect(reviewGate({ ...stale, authorWorking: true })).toBe('author_fixing');
    // Fix pushed, re-review dispatched.
    expect(reviewGate({ ...stale, reviewActivity: 'running' })).toBe(
      'reviewing'
    );
    // Fix pushed, re-review held until CI is green.
    expect(reviewGate({ ...stale, ciStatus: 'pending' })).toBe('waiting_ci');
    // Nothing happening yet: the verdict is the state.
    expect(reviewGate({ ...stale, ciStatus: 'passing' })).toBe(
      'changes_requested'
    );
  });

  it('escalates when changes are still requested after the last round', () => {
    const spent = { reviewResult: 'changes_requested', roundsExhausted: true };
    // PR #585: third request_changes, loop stopped.
    expect(reviewGate({ ...spent, ciStatus: 'passing' })).toBe('escalated');
    // A human follow-up running on the author's workspace still shows as work.
    expect(reviewGate({ ...spent, authorWorking: true })).toBe('author_fixing');
    // An approval on the last round is not an escalation.
    expect(
      reviewGate({ reviewResult: 'approved', roundsExhausted: true })
    ).toBe('approved');
  });

  it('hands an addressed fix to the human when no round is left', () => {
    // PR #585: author pushed 682583c, the requested changes were marked
    // addressed (verdict cleared) and no re-review can come.
    expect(reviewGate({ roundsExhausted: true, ciStatus: 'passing' })).toBe(
      'addressed'
    );
    // With rounds left the same state just waits for the re-review.
    expect(reviewGate({ ciStatus: 'passing' })).toBe('awaiting');
  });

  it('approved beats CI state', () => {
    expect(
      reviewGate({ reviewResult: 'approved', ciStatus: 'failing' })
    ).toBe('approved');
  });
});
