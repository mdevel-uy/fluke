import { describe, it, expect } from 'vitest';
import { buildMilestonePlan } from './milestonePlan';
import type { RepoIssue } from '@/features/issues/types';

function issue(
  number: number,
  milestone: string | null,
  labelNames: string[],
  state: 'open' | 'closed' = 'open'
): RepoIssue {
  return {
    id: `i${number}`,
    repo_id: 'r1',
    number,
    title: `issue ${number}`,
    body: '',
    state,
    labels: labelNames.map((name) => ({ name, color: '000000' })),
    author: 'someone',
    updated_at: new Date(0),
    synced_at: new Date(0),
    milestone,
    priority: null,
    closed_at: null,
  } as unknown as RepoIssue;
}

const noTasks = new Map<number, { status: string }>();
const stateOf = (plan: ReturnType<typeof buildMilestonePlan>, n: number) =>
  plan.bands
    .flatMap((b) => b.waves.flatMap((w) => w.cards))
    .find((c) => c.issue.number === n)?.state;

describe('buildMilestonePlan', () => {
  it('an open issue that needs a person reads as stuck', () => {
    const plan = buildMilestonePlan(
      [issue(1, 'M1', ['wave:0']), issue(2, 'M1', ['wave:0'], 'closed')],
      new Map([[1, { status: 'waiting_user' }]]),
      new Set([1, 2])
    );
    expect(stateOf(plan, 1)).toBe('stuck');
    expect(stateOf(plan, 2)).toBe('done');
  });

  it('groups by milestone and wave, sending the rest to the loose bucket', () => {
    const plan = buildMilestonePlan(
      [
        issue(1, 'M1', ['wave:0']),
        issue(2, 'M1', ['wave:1']),
        issue(3, null, ['wave:0']),
        issue(4, 'M1', []),
        issue(5, 'M1', ['wave:temprana']),
        issue(6, 'M1', ['wave:-1']),
      ],
      noTasks
    );
    expect(plan.bands).toHaveLength(1);
    expect(plan.bands[0].waves.map((w) => w.wave)).toEqual([0, 1]);
    expect(plan.bands[0].waveCount).toBe(2);
    expect(plan.loose.map((i) => i.number)).toEqual([3, 4, 5, 6]);
    expect(plan.columnCount).toBe(2);
  });

  it('derives ready, gate and blocked from the current wave and pm:decision', () => {
    const plan = buildMilestonePlan(
      [
        issue(1, 'M1', ['wave:0']),
        issue(2, 'M1', ['wave:0', 'pm:decision']),
        issue(3, 'M1', ['wave:1']),
      ],
      noTasks
    );
    expect(stateOf(plan, 1)).toBe('ready');
    expect(stateOf(plan, 2)).toBe('gate');
    expect(stateOf(plan, 3)).toBe('blocked');
    expect(plan.bands[0].currentWave).toBe(0);
  });

  it('maps task statuses and treats closed issues as merged', () => {
    const tasks = new Map([
      [1, { status: 'queued' }],
      [2, { status: 'in_progress' }],
      [3, { status: 'waiting_user' }],
      [4, { status: 'in_review' }],
      [5, { status: 'approved' }],
      [7, { status: 'failed' }],
    ]);
    const plan = buildMilestonePlan(
      [
        issue(1, 'M1', ['wave:0']),
        issue(2, 'M1', ['wave:0']),
        issue(3, 'M1', ['wave:0']),
        issue(4, 'M1', ['wave:0']),
        issue(5, 'M1', ['wave:0']),
        issue(6, 'M1', ['wave:0'], 'closed'),
        issue(7, 'M1', ['wave:0']),
      ],
      tasks
    );
    expect(stateOf(plan, 1)).toBe('queued');
    expect(stateOf(plan, 2)).toBe('running');
    expect(stateOf(plan, 3)).toBe('running');
    expect(stateOf(plan, 4)).toBe('review');
    expect(stateOf(plan, 5)).toBe('review');
    expect(stateOf(plan, 6)).toBe('done');
    // A failed task reads as no task: back to waiting for a dispatch.
    expect(stateOf(plan, 7)).toBe('ready');
    expect(plan.bands[0].done).toBe(1);
    expect(plan.bands[0].status).toEqual({
      kind: 'running',
      wave: 0,
      count: 7,
    });
  });

  it('moves the current wave forward once the previous one is merged', () => {
    const plan = buildMilestonePlan(
      [issue(1, 'M1', ['wave:0'], 'closed'), issue(2, 'M1', ['wave:1'])],
      noTasks
    );
    expect(plan.bands[0].currentWave).toBe(1);
    expect(stateOf(plan, 2)).toBe('ready');
  });

  it('reports a band that can only start with a decision', () => {
    const plan = buildMilestonePlan(
      [issue(1, 'M1', ['wave:0', 'pm:decision']), issue(2, 'M1', ['wave:1'])],
      noTasks
    );
    expect(plan.bands[0].status).toEqual({ kind: 'decision', issueNumber: 1 });
  });

  it('puts bands with ready work first and finished milestones last', () => {
    const plan = buildMilestonePlan(
      [
        issue(1, 'A-done', ['wave:0'], 'closed'),
        issue(2, 'B-gate', ['wave:0', 'pm:decision']),
        issue(3, 'C-ready', ['wave:0']),
      ],
      noTasks
    );
    expect(plan.bands.map((b) => b.milestone)).toEqual([
      'C-ready',
      'B-gate',
      'A-done',
    ]);
  });

  it('keeps closed issues out of the loose bucket', () => {
    const plan = buildMilestonePlan([issue(1, null, [], 'closed')], noTasks);
    expect(plan.loose).toEqual([]);
  });
});
