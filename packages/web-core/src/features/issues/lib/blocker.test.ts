import { describe, it, expect } from 'vitest';
import { blockerAge } from './blocker';

describe('blockerAge', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  it('reads SQLite and RFC 3339 dates as UTC', () => {
    expect(blockerAge('2026-10-03 11:46:00', now)).toBe('14 min');
    expect(blockerAge('2026-10-03T10:00:00.5+00:00', now)).toBe('2 h');
    expect(blockerAge('2026-09-30 12:00:00', now)).toBe('3 d');
  });
  it('is null without a date', () => {
    expect(blockerAge(null, now)).toBeNull();
    expect(blockerAge('nope', now)).toBeNull();
  });
});
