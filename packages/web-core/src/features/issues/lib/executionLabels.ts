import type { IssueLabel } from 'shared/types';
import type { RepoIssue } from '@/features/issues/types';

/**
 * Execution-label convention — the frontend half.
 *
 * Three GitHub label families describe how a backlog can be executed without
 * two workers colliding:
 *
 * - `feature:<slug>` — which body of work the issue belongs to. Groups.
 * - `wave:<n>` — execution order WITHIN the feature. Every issue sharing a
 *   feature and a wave is meant to be launchable in parallel.
 * - `resource:<slug>` — a repo-global serialized resource (migration
 *   numbering, a lockfile, a generated types file). Unlike the other two it
 *   CROSSES features: two issues from unrelated features that claim the same
 *   resource still collide.
 *
 * The analyst emits these when it writes the issues (see
 * `ANALYST_EXECUTION_LABELS_CONTRACT` on the Rust side, which is the
 * authoritative statement of what a wave promises). Nothing here infers
 * anything: an issue that was not labelled is reported as unclassified, never
 * as safe. The Rust mirror of these prefixes lives in
 * `crates/services/src/services/execution_labels.rs` — the two must agree.
 */

export const FEATURE_PREFIX = 'feature:';
export const WAVE_PREFIX = 'wave:';
export const RESOURCE_PREFIX = 'resource:';

type NamedLabel = Pick<IssueLabel, 'name'>;

/**
 * Strip `prefix` from `name`, matching the prefix case-insensitively so an
 * analyst that writes `Feature:` does not create a second phantom family.
 * Returns the trimmed remainder, or `null` when the prefix does not match.
 */
function stripPrefix(name: string, prefix: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < prefix.length) return null;
  const head = trimmed.slice(0, prefix.length);
  if (head.toLowerCase() !== prefix.toLowerCase()) return null;
  return trimmed.slice(prefix.length).trim();
}

/** Feature slug of the first `feature:` label, or `null` when absent/empty. */
export function featureSlug(labels: readonly NamedLabel[]): string | null {
  for (const label of labels) {
    const slug = stripPrefix(label.name, FEATURE_PREFIX);
    if (slug) return slug;
  }
  return null;
}

/**
 * Wave number of the first well-formed `wave:` label.
 *
 * Only non-negative integers count. `wave:temprana` and `wave:-1` are typos,
 * not orders — treating them as 0 would sort them ahead of the real first
 * wave and hide the mistake behind a plausible value, so they read as "no
 * wave" and the issue surfaces in the unwaved bucket where a human sees it.
 */
export function waveNumber(labels: readonly NamedLabel[]): number | null {
  for (const label of labels) {
    const raw = stripPrefix(label.name, WAVE_PREFIX);
    if (raw === null) continue;
    if (!/^\d+$/.test(raw)) continue;
    return Number(raw);
  }
  return null;
}

/** Every `resource:` slug on the issue, deduplicated, in label order. */
export function resourceSlugs(labels: readonly NamedLabel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const slug = stripPrefix(label.name, RESOURCE_PREFIX);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** True when the label belongs to the convention (any family). */
export function isExecutionLabel(name: string): boolean {
  return (
    stripPrefix(name, FEATURE_PREFIX) !== null ||
    stripPrefix(name, WAVE_PREFIX) !== null ||
    stripPrefix(name, RESOURCE_PREFIX) !== null
  );
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Issues of one feature that the analyst marked as launchable together. */
export interface ExecutionWave {
  wave: number;
  issues: RepoIssue[];
}

export interface ExecutionFeature {
  feature: string;
  /** Ascending by wave number. */
  waves: ExecutionWave[];
  /** Carries a `feature:` but no usable `wave:` — cannot be planned. */
  unwaved: RepoIssue[];
}

/**
 * Two or more issues claiming the same serialized resource. Reported
 * separately from the waves because it is the one signal that crosses
 * features: the analyst planning feature A cannot see that feature B also
 * adds a migration, so only this view can.
 */
export interface ResourceContention {
  resource: string;
  issues: RepoIssue[];
}

export interface ExecutionPlan {
  features: ExecutionFeature[];
  /** No `feature:` label at all — typically human-written issues. */
  unclassified: RepoIssue[];
  contentions: ResourceContention[];
}

function byIssueNumber(a: RepoIssue, b: RepoIssue): number {
  return a.number - b.number;
}

/**
 * Group issues into the execution plan the board renders.
 *
 * Only OPEN issues participate: a closed issue is never going to be handed to
 * a worker, so including it would invent waves that are already spent and,
 * worse, report resource contention that cannot happen.
 *
 * Nothing is inferred. An issue without `feature:` lands in `unclassified`
 * and an issue without a usable `wave:` lands in its feature's `unwaved`
 * bucket — both are displayed as "run this one alone", because the absence of
 * a declaration is not evidence that the issue is safe to parallelise.
 */
export function buildExecutionPlan(
  issues: readonly RepoIssue[]
): ExecutionPlan {
  const open = issues.filter((i) => i.state === 'open');

  const unclassified: RepoIssue[] = [];
  const byFeature = new Map<
    string,
    { waves: Map<number, RepoIssue[]>; unwaved: RepoIssue[] }
  >();
  const byResource = new Map<string, RepoIssue[]>();

  for (const issue of open) {
    for (const resource of resourceSlugs(issue.labels)) {
      const list = byResource.get(resource);
      if (list) list.push(issue);
      else byResource.set(resource, [issue]);
    }

    const feature = featureSlug(issue.labels);
    if (!feature) {
      unclassified.push(issue);
      continue;
    }

    let entry = byFeature.get(feature);
    if (!entry) {
      entry = { waves: new Map(), unwaved: [] };
      byFeature.set(feature, entry);
    }

    const wave = waveNumber(issue.labels);
    if (wave === null) {
      entry.unwaved.push(issue);
      continue;
    }
    const list = entry.waves.get(wave);
    if (list) list.push(issue);
    else entry.waves.set(wave, [issue]);
  }

  const features: ExecutionFeature[] = Array.from(byFeature.entries())
    .map(([feature, entry]) => ({
      feature,
      waves: Array.from(entry.waves.entries())
        .map(([wave, waveIssues]) => ({
          wave,
          issues: [...waveIssues].sort(byIssueNumber),
        }))
        .sort((a, b) => a.wave - b.wave),
      unwaved: [...entry.unwaved].sort(byIssueNumber),
    }))
    .sort((a, b) => a.feature.localeCompare(b.feature));

  const contentions: ResourceContention[] = Array.from(byResource.entries())
    .filter(([, list]) => list.length > 1)
    .map(([resource, list]) => ({
      resource,
      issues: [...list].sort(byIssueNumber),
    }))
    .sort((a, b) => a.resource.localeCompare(b.resource));

  return {
    features,
    unclassified: [...unclassified].sort(byIssueNumber),
    contentions,
  };
}
