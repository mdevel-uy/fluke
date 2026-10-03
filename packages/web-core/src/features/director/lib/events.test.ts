import { describe, expect, it } from 'vitest';
import {
  eventLines,
  isEventsBatch,
  isSilentReply,
  stripFlukeContext,
} from './events';

describe('Fluke event batches', () => {
  it('recognizes batches and silent replies', () => {
    const batch =
      '[EVENTS]\n- 09:31 task.failed [alert] issue #710: developer · infra\n- 09:36 pr.ci_failing [alert] PR #725';
    expect(isEventsBatch(batch)).toBe(true);
    expect(isEventsBatch('hola [EVENTS]')).toBe(false);
    expect(eventLines(batch)).toEqual([
      '09:31 task.failed [alert] issue #710: developer · infra',
      '09:36 pr.ci_failing [alert] PR #725',
    ]);
    expect(isSilentReply(' SILENT\n')).toBe(true);
    expect(isSilentReply('SILENT: nada')).toBe(false);
  });

  it('hides the per-turn context block', () => {
    const msg =
      '<fluke-context>\n[APP CONTEXT]\nIssues\n\n[STATUS]\nTasks: 1 running\n</fluke-context>\n\n[EVENTS]\n- 09:31 task.failed [alert]';
    expect(stripFlukeContext(msg)).toBe('[EVENTS]\n- 09:31 task.failed [alert]');
    expect(stripFlukeContext('hola')).toBe('hola');
  });
});
