import { describe, expect, it } from 'vitest';
import { arrangeMilestones, moveMilestone } from './milestoneOrder';
import { milestoneTags } from './milestoneTags';

const b = (milestone: string) => ({ milestone });
const names = (xs: { milestone: string }[]) => xs.map((x) => x.milestone);

describe('arrangeMilestones', () => {
  it('puts starred first and follows the saved order, unknown ones last', () => {
    const r = arrangeMilestones(
      [b('a'), b('b'), b('c'), b('d')],
      ['c'],
      ['d', 'c', 'b']
    );
    expect(names(r.starred)).toEqual(['c']);
    expect(names(r.rest)).toEqual(['d', 'b', 'a']);
  });
});

describe('moveMilestone', () => {
  it('moves down and up within what is shown', () => {
    expect(moveMilestone([], ['a', 'b', 'c'], 'a', 'c')).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(moveMilestone([], ['a', 'b', 'c'], 'c', 'a')).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('keeps hidden milestones in the saved order', () => {
    expect(moveMilestone(['x', 'a', 'b'], ['a', 'b'], 'b', 'a')).toEqual([
      'b',
      'a',
      'x',
    ]);
  });

  it('ignores a drop outside what is shown', () => {
    expect(moveMilestone(['a'], ['a', 'b'], 'a', 'z')).toEqual(['a']);
  });
});

describe('milestoneTags', () => {
  const l = (name: string) => ({ name, color: '000000' });

  it('keeps the highest priority first and drops control labels', () => {
    const tags = milestoneTags([
      { labels: [l('P2'), l('bug'), l('wave:0'), l('feature:x')] },
      { labels: [l('priority: high'), l('ui'), l('bug'), l('pm:decision')] },
      { labels: [l('epic'), l('ui'), l('bug')] },
    ]);
    expect(tags.map((t) => t.name)).toEqual(['priority: high', 'bug', 'ui']);
    expect(tags[0].priority).toBe(true);
  });
});
