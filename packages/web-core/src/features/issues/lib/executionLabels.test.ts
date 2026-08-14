import { describe, it, expect } from 'vitest';
import {
  buildExecutionPlan,
  featureSlug,
  isExecutionLabel,
  resourceSlugs,
  waveNumber,
} from './executionLabels';
import type { RepoIssue } from '@/features/issues/types';

function labels(...names: string[]) {
  return names.map((name) => ({ name, color: '000000' }));
}

function issue(
  number: number,
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
    labels: labels(...labelNames),
    author: 'someone',
    updated_at: new Date(0),
    synced_at: new Date(0),
    milestone: null,
    priority: null,
    closed_at: null,
  } as unknown as RepoIssue;
}

describe('label parsing', () => {
  it('reads each family', () => {
    const l = labels('feature:rss-v1', 'wave:2', 'resource:db-migration', 'P1');
    expect(featureSlug(l)).toBe('rss-v1');
    expect(waveNumber(l)).toBe(2);
    expect(resourceSlugs(l)).toEqual(['db-migration']);
  });

  it('matches the prefix case-insensitively but preserves the slug', () => {
    expect(featureSlug(labels('Feature:RSS-v1'))).toBe('RSS-v1');
    expect(waveNumber(labels('WAVE:3'))).toBe(3);
  });

  it('tolerates whitespace around the prefix and the slug', () => {
    expect(featureSlug(labels('  feature: rss-v1 '))).toBe('rss-v1');
    expect(waveNumber(labels('wave: 4 '))).toBe(4);
  });

  it('ignores empty slugs', () => {
    expect(featureSlug(labels('feature:'))).toBeNull();
    expect(resourceSlugs(labels('resource:  '))).toEqual([]);
  });

  /**
   * A malformed wave must not become wave 0: that would sort it ahead of the
   * real first wave and bury the typo behind a plausible value.
   */
  it('treats malformed waves as absent rather than as wave 0', () => {
    expect(waveNumber(labels('wave:temprana'))).toBeNull();
    expect(waveNumber(labels('wave:-1'))).toBeNull();
    expect(waveNumber(labels('wave:1.5'))).toBeNull();
    expect(waveNumber(labels('wave:'))).toBeNull();
  });

  it('does not classify labels outside the convention', () => {
    for (const name of ['P1', 'backend', 'featureish', 'waved']) {
      expect(isExecutionLabel(name)).toBe(false);
    }
    expect(isExecutionLabel('feature:x')).toBe(true);
  });

  /** Parity with the Rust parser, which had to guard byte-slicing here. */
  it('handles multibyte label names and slugs', () => {
    for (const name of ['日本語ラベル', 'área', '🙂']) {
      expect(isExecutionLabel(name)).toBe(false);
    }
    expect(featureSlug(labels('feature:área-de-pagos'))).toBe('área-de-pagos');
    expect(resourceSlugs(labels('resource:日本語'))).toEqual(['日本語']);
  });

  it('deduplicates repeated resource claims', () => {
    expect(
      resourceSlugs(labels('resource:db-migration', 'resource:db-migration'))
    ).toEqual(['db-migration']);
  });
});

describe('buildExecutionPlan', () => {
  it('groups by feature then wave, ascending', () => {
    const plan = buildExecutionPlan([
      issue(3, ['feature:billing-v2', 'wave:1']),
      issue(1, ['feature:billing-v2', 'wave:0']),
      issue(2, ['feature:billing-v2', 'wave:1']),
      issue(9, ['feature:rss-v1', 'wave:0']),
    ]);

    expect(plan.features.map((f) => f.feature)).toEqual([
      'billing-v2',
      'rss-v1',
    ]);
    const billing = plan.features[0];
    expect(billing.waves.map((w) => w.wave)).toEqual([0, 1]);
    expect(billing.waves[1].issues.map((i) => i.number)).toEqual([2, 3]);
  });

  /**
   * The whole point of the convention: an unlabelled issue must never be
   * reported as parallel-safe. It gets its own bucket so the human sees the
   * gap and runs it alone.
   */
  it('puts issues without a feature into unclassified', () => {
    const plan = buildExecutionPlan([
      issue(1, ['feature:billing-v2', 'wave:0']),
      issue(2, ['P1']),
      issue(3, []),
    ]);
    expect(plan.unclassified.map((i) => i.number)).toEqual([2, 3]);
    expect(plan.features).toHaveLength(1);
  });

  it('separates issues that have a feature but no usable wave', () => {
    const plan = buildExecutionPlan([
      issue(1, ['feature:billing-v2', 'wave:0']),
      issue(2, ['feature:billing-v2']),
      issue(3, ['feature:billing-v2', 'wave:oops']),
    ]);
    const billing = plan.features[0];
    expect(billing.unwaved.map((i) => i.number)).toEqual([2, 3]);
    expect(billing.waves).toHaveLength(1);
  });

  /**
   * The one signal that crosses features. The analyst planning `rss-v1`
   * cannot know `billing-v2` also adds a migration; only this view can.
   */
  it('reports resource contention across features', () => {
    const plan = buildExecutionPlan([
      issue(1, ['feature:billing-v2', 'wave:0', 'resource:db-migration']),
      issue(2, ['feature:rss-v1', 'wave:0', 'resource:db-migration']),
      issue(3, ['feature:rss-v1', 'wave:1', 'resource:lockfile']),
    ]);
    expect(plan.contentions).toHaveLength(1);
    expect(plan.contentions[0].resource).toBe('db-migration');
    expect(plan.contentions[0].issues.map((i) => i.number)).toEqual([1, 2]);
  });

  /**
   * A closed issue is never handed to a worker, so it can neither occupy a
   * wave nor contend for a resource. Including it would invent conflicts that
   * cannot happen.
   */
  it('ignores closed issues entirely', () => {
    const plan = buildExecutionPlan([
      issue(1, ['feature:billing-v2', 'wave:0', 'resource:db-migration']),
      issue(2, ['feature:rss-v1', 'wave:0', 'resource:db-migration'], 'closed'),
      issue(3, ['P1'], 'closed'),
    ]);
    expect(plan.contentions).toEqual([]);
    expect(plan.unclassified).toEqual([]);
    expect(plan.features).toHaveLength(1);
  });

  it('returns an empty plan for an empty backlog', () => {
    const plan = buildExecutionPlan([]);
    expect(plan).toEqual({
      features: [],
      unclassified: [],
      contentions: [],
    });
  });
});
