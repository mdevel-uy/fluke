import { describe, expect, it } from 'vitest';
import type { PlanStep } from 'shared/types';
import { COL_WIDTH, ROW_HEIGHT, effectiveDeps, layoutSteps } from './layout';

const step = (n: number, depends_on: number[] = []): PlanStep => ({
  id: String(n),
  n,
  title: `s${n}`,
  summary: '',
  files: [],
  verify: null,
  depends_on,
  state: 'pending',
  version: 1,
  has_checkpoint: false,
  started_at: null,
  finished_at: null,
});

describe('plan layout', () => {
  it('chains steps without declared deps in order', () => {
    const steps = [step(2), step(1), step(3)];
    expect(effectiveDeps(steps).get(3)).toEqual([2]);
    const pos = layoutSteps(steps);
    expect(pos.get(1)).toEqual({ x: 0, y: 0 });
    expect(pos.get(3)).toEqual({ x: 2 * COL_WIDTH, y: 0 });
  });

  it('puts parallel steps in the same column, centered', () => {
    const pos = layoutSteps([
      step(1),
      step(2, [1]),
      step(3, [1]),
      step(4, [2, 3]),
    ]);
    expect(pos.get(2)).toEqual({ x: COL_WIDTH, y: -ROW_HEIGHT / 2 });
    expect(pos.get(3)).toEqual({ x: COL_WIDTH, y: ROW_HEIGHT / 2 });
    expect(pos.get(4)?.x).toBe(2 * COL_WIDTH);
  });

  it('ignores unknown deps and survives cycles', () => {
    const pos = layoutSteps([step(1, [2]), step(2, [1]), step(3, [99])]);
    expect(pos.size).toBe(3);
  });

  it('stacks layers top to bottom in vertical mode', () => {
    const pos = layoutSteps([step(1), step(2, [1]), step(3, [1])], true);
    expect(pos.get(1)).toEqual({ x: 0, y: 0 });
    expect(pos.get(2)).toEqual({ x: -COL_WIDTH / 2, y: ROW_HEIGHT });
    expect(pos.get(3)).toEqual({ x: COL_WIDTH / 2, y: ROW_HEIGHT });
  });
});
