import { describe, it, expect } from 'vitest';
import type { MissionDetail } from 'shared/types';
import {
  briefTemplate,
  currentStep,
  missionDelivery,
  readyToRun,
} from './missionSteps';

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
    design: false,
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

describe('design ready vs. feature implemented (#758)', () => {
  const design = { ...issue('closed'), number: 2, design: true };

  it('a merged mock with no implementation yet is design ready, not done', () => {
    const d = detail({
      analyst_status: 'done',
      proposal: [design],
      delivery: 'design_ready',
    });
    expect(missionDelivery(d)).toBe('design_ready');
    expect(currentStep(d)).toBe(2);
    expect(readyToRun(d)).toBe(false);
  });

  it('a closed design with the implementation open waits for the play', () => {
    const d = detail({
      analyst_status: 'done',
      proposal: [design, issue()],
      delivery: 'design_ready',
    });
    expect(currentStep(d)).toBe(2);
    expect(readyToRun(d)).toBe(true);
  });

  it('follows the implementation while it runs', () => {
    const d = detail({
      analyst_status: 'done',
      proposal: [design, issue()],
      execution: 'running',
      delivery: 'implementing',
    });
    expect(missionDelivery(d)).toBe('implementing');
    expect(currentStep(d)).toBe(4);
  });

  it('is done once the implementation closes', () => {
    const d = detail({
      analyst_status: 'done',
      proposal: [design, issue('closed')],
      execution: 'running',
      delivery: 'implemented',
    });
    expect(missionDelivery(d)).toBe('implemented');
    expect(currentStep(d)).toBe(5);
  });

  it('keeps the usual reading without design issues', () => {
    const open = detail({ analyst_status: 'done', proposal: [issue()] });
    expect(missionDelivery(open)).toBeNull();
    expect(currentStep(open)).toBe(2);
    const closed = detail({
      analyst_status: 'done',
      proposal: [issue('closed')],
      delivery: null,
    });
    expect(missionDelivery(closed)).toBeNull();
    expect(currentStep(closed)).toBe(5);
  });
});
