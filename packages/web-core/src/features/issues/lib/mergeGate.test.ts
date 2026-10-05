import { describe, it, expect } from 'vitest';
import { mergeGateState } from './mergeGate';

describe('mergeGateState', () => {
  it('lets a mergeable PR with green CI merge without notice', () => {
    expect(mergeGateState('mergeable', 'passing')).toMatchObject({
      block: null,
      notice: null,
    });
  });

  it('blocks on conflicts, red CI or both', () => {
    expect(mergeGateState('conflicting', 'passing').block).toBe('conflicts');
    expect(mergeGateState('mergeable', 'failing').block).toBe('ciFailing');
    expect(mergeGateState('conflicting', 'failing').block).toBe('both');
  });

  it('lets uncertain states merge with a notice', () => {
    expect(mergeGateState('mergeable', 'pending').notice).toBe('ciPending');
    expect(mergeGateState('mergeable', 'unknown').notice).toBe('ciUnavailable');
    expect(mergeGateState('mergeable', null).notice).toBe('ciUnavailable');
    expect(mergeGateState('unknown', 'passing').notice).toBe(
      'mergeableUnknown'
    );
    expect(mergeGateState('mergeable', 'none')).toMatchObject({
      block: null,
      notice: 'ciNone',
    });
  });
});
