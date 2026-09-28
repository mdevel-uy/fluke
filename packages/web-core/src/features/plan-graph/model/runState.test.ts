import { describe, expect, it } from 'vitest';
import type { PlanSnapshot, PlanStep } from 'shared/types';
import { deriveRunState } from './runState';

const step = (n: number, state: string, has_checkpoint = false): PlanStep => ({
  id: String(n),
  n,
  title: `s${n}`,
  summary: '',
  files: [],
  verify: null,
  depends_on: [],
  state,
  version: 1,
  has_checkpoint,
  started_at: null,
  finished_at: null,
});

const plan = (
  steps: PlanStep[],
  status = 'running',
  pause_requested = false
): PlanSnapshot => ({
  workspace_id: 'w',
  status,
  pause_requested,
  steps,
  revisions: [],
});

describe('deriveRunState', () => {
  it('running agent on an active step', () => {
    const s = deriveRunState(
      plan([
        step(1, 'done', true),
        step(2, 'active', true),
        step(3, 'pending'),
      ]),
      true
    );
    expect(s.label).toBe('running');
    expect(s.here).toEqual({ n: 2, kind: 'active' });
    expect(s.backTarget?.n).toBe(2);
    expect(s.canPlay).toBe(false);
    expect([s.done, s.total]).toEqual([1, 3]);
  });

  it('pause requested while running', () => {
    const s = deriveRunState(
      plan([step(1, 'active', true)], 'running', true),
      true
    );
    expect(s.label).toBe('pausing');
  });

  it('paused at a step boundary waits on the next step', () => {
    const s = deriveRunState(
      plan([step(1, 'done', true), step(2, 'pending')], 'paused'),
      false
    );
    expect(s.label).toBe('paused');
    expect(s.here).toEqual({ n: 2, kind: 'queued' });
    // |< from the boundary goes back to the last finished step.
    expect(s.backTarget?.n).toBe(1);
    expect(s.canPlay).toBe(true);
    expect(s.canStop).toBe(false);
  });

  it('finished plan with the agent gone', () => {
    const s = deriveRunState(
      plan([step(1, 'done', true), step(2, 'cut')]),
      false
    );
    expect(s.label).toBe('finished');
    expect(s.canPlay).toBe(false);
    expect(s.total).toBe(1);
  });

  it('no back target without checkpoints', () => {
    const s = deriveRunState(plan([step(1, 'active')]), true);
    expect(s.backTarget).toBeNull();
  });
});
