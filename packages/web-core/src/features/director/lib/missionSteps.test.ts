import { describe, it, expect } from 'vitest';
import type { MissionDetail } from 'shared/types';
import { briefTemplate, currentStep, readyToRun } from './missionSteps';

function detail(over: Partial<MissionDetail> & { status?: string }) {
  const { status = 'planning', ...rest } = over;
  return {
    mission: { status },
    items: [],
    proposal: [],
    analyst_status: null,
    execution: 'none',
    ...rest,
  } as unknown as MissionDetail;
}

const issue = (state = 'open') =>
  ({
    number: 1,
    title: 't',
    state,
    milestone: 'M',
    wave: 0,
    decision: false,
  }) as const;

describe('currentStep', () => {
  it('follows the mission through its steps', () => {
    expect(currentStep(detail({ status: 'clarifying' }))).toBe(0);
    expect(currentStep(detail({ status: 'brief_ready' }))).toBe(1);
    expect(currentStep(detail({ analyst_status: 'in_progress' }))).toBe(2);
    const ready = detail({ analyst_status: 'done', proposal: [issue()] });
    expect(currentStep(ready)).toBe(2);
    expect(readyToRun(ready)).toBe(true);
    expect(
      currentStep(
        detail({
          analyst_status: 'done',
          proposal: [issue()],
          execution: 'planning',
        })
      )
    ).toBe(3);
    expect(
      currentStep(
        detail({
          analyst_status: 'done',
          proposal: [issue()],
          execution: 'running',
        })
      )
    ).toBe(4);
    expect(
      currentStep(
        detail({ analyst_status: 'done', proposal: [issue('closed')] })
      )
    ).toBe(5);
  });
});

describe('briefTemplate', () => {
  it('reads TDD and design from the items', () => {
    const d = detail({
      items: [
        { item: { kind: 'feature', fields: { tdd: 'sí' } }, checklist: [] },
        { item: { kind: 'bug', fields: { tdd: 'no aplica' } }, checklist: [] },
      ],
    } as never);
    expect(briefTemplate(d)).toEqual({ tdd: true, design: false });
  });
});
