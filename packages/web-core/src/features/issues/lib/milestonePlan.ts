import type { RepoIssue } from '@/features/issues/types';
import { waveNumber } from './executionLabels';

/**
 * The Plan view (fluke v2, decision 7): one band per GitHub milestone, its
 * issues laid out in columns by `wave:<n>`.
 *
 * Nothing is inferred. An issue without a milestone, or without a well-formed
 * `wave:` label (`wave:temprana` and `wave:-1` included), goes to the loose
 * bucket and is dispatched alone; it is never folded into wave 0.
 */

export const PM_DECISION_LABEL = 'pm:decision';

export type PlanCardState =
  | 'ready'
  | 'gate'
  | 'blocked'
  | 'queued'
  | 'running'
  | 'review'
  /** Reviewer approved the PR: waits for a person to merge it. */
  | 'approved'
  | 'stuck'
  | 'done';

/**
 * States a card can have inside a band. Approved PRs are never drawn in a
 * band (#759): they only show in the "waiting on you" section.
 */
export type BandCardState = Exclude<PlanCardState, 'approved'>;

export interface PlanCard {
  issue: RepoIssue;
  wave: number;
  state: BandCardState;
}

export interface PlanWave {
  wave: number;
  cards: PlanCard[];
}

export type PlanBandStatus =
  | { kind: 'ready' }
  | { kind: 'decision'; issueNumber: number }
  /**
   * Nothing else is moving and the current wave only waits for approved PRs
   * to be merged. Points at the "waiting on you" section; the PRs themselves
   * are not in the band.
   */
  | { kind: 'awaitingYou'; count: number }
  | { kind: 'running'; wave: number; count: number };

export interface MilestoneBand {
  milestone: string;
  /** Populated waves only, ascending. Gaps are drawn as empty columns. */
  waves: PlanWave[];
  /** Number of populated waves ("N waves" in the band status line). */
  waveCount: number;
  /**
   * Lowest wave that still has something not merged; null when all are. An
   * approved PR is not merged yet, so it holds its wave as current.
   */
  currentWave: number | null;
  /** Merged issues of the milestone. */
  done: number;
  /**
   * Every issue of the milestone, approved PRs included: "done of total
   * merged" and the finished check must not treat an unmerged PR as merged.
   */
  total: number;
  status: PlanBandStatus;
}

/** An approved PR that waits for a person to merge it (#759). */
export interface AwaitingMergeItem {
  issue: RepoIssue;
  /** Null for a loose issue (no milestone or no usable `wave:`). */
  milestone: string | null;
}

export interface MilestonePlan {
  bands: MilestoneBand[];
  /**
   * Open issues without a milestone or without a usable `wave:`. Loose
   * issues with an approved PR are not here: they live in `awaitingMerge`.
   */
  loose: RepoIssue[];
  /**
   * Every approved PR not merged yet, from all bands and the loose bucket,
   * ordered by issue number. Merging the PR closes the issue or moves the
   * task to `done`, which takes it out of here.
   */
  awaitingMerge: AwaitingMergeItem[];
  /** Columns every band draws: highest wave + 1. */
  columnCount: number;
}

type TaskLike = { status: string };

const TASK_STATE: Record<string, PlanCardState> = {
  queued: 'queued',
  in_progress: 'running',
  // Agent waiting for the user's answer (#662) is still running work.
  waiting_user: 'running',
  in_review: 'review',
  approved: 'approved',
  done: 'done',
};

const byNumber = (a: RepoIssue, b: RepoIssue) => a.number - b.number;

/**
 * `taskByIssueNumber` holds the task that represents each issue (the active
 * one, otherwise a finished one). A `failed` task reads as no task: the issue
 * is back to waiting for a dispatch. An open issue in `stuck` (#694: it
 * needs a person) shows as stuck whatever its task says.
 */
export function buildMilestonePlan(
  issues: readonly RepoIssue[],
  taskByIssueNumber: ReadonlyMap<number, TaskLike>,
  stuck: ReadonlySet<number> = new Set()
): MilestonePlan {
  const loose: RepoIssue[] = [];
  const awaitingMerge: AwaitingMergeItem[] = [];
  const byMilestone = new Map<string, RepoIssue[]>();

  for (const issue of issues) {
    const wave = waveNumber(issue.labels);
    if (!issue.milestone || wave === null) {
      if (issue.state !== 'open') continue;
      const task = taskByIssueNumber.get(issue.number);
      if (task?.status === 'approved' && !stuck.has(issue.number)) {
        awaitingMerge.push({ issue, milestone: null });
      } else {
        loose.push(issue);
      }
      continue;
    }
    const list = byMilestone.get(issue.milestone);
    if (list) list.push(issue);
    else byMilestone.set(issue.milestone, [issue]);
  }

  const bands: MilestoneBand[] = [];
  // Finished milestones (every issue closed) stay in: the Plan sidebar
  // decides whether to show them.
  for (const [milestone, list] of byMilestone) {
    const raw = list.map((issue) => {
      const task = taskByIssueNumber.get(issue.number);
      const taskState = task ? TASK_STATE[task.status] : undefined;
      return {
        issue,
        wave: waveNumber(issue.labels)!,
        taskState:
          issue.state !== 'open'
            ? 'done'
            : stuck.has(issue.number)
              ? 'stuck'
              : taskState,
      };
    });

    const open = raw.filter((c) => c.taskState !== 'done');
    const currentWave = open.length
      ? Math.min(...open.map((c) => c.wave))
      : null;

    // Approved PRs leave the band: they wait for the user's merge in the
    // "waiting on you" section, not as work of their wave.
    const cards: PlanCard[] = [];
    let approved = 0;
    for (const c of raw) {
      const taskState = c.taskState;
      if (taskState === 'approved') {
        approved++;
        awaitingMerge.push({ issue: c.issue, milestone });
        continue;
      }
      cards.push({
        issue: c.issue,
        wave: c.wave,
        state:
          taskState ??
          (c.wave !== currentWave
            ? 'blocked'
            : c.issue.labels.some((l) => l.name === PM_DECISION_LABEL)
              ? 'gate'
              : 'ready'),
      });
    }

    const waveMap = new Map<number, PlanCard[]>();
    for (const card of cards) {
      const w = waveMap.get(card.wave);
      if (w) w.push(card);
      else waveMap.set(card.wave, [card]);
    }
    const waves = [...waveMap.entries()]
      .map(([wave, wc]) => ({
        wave,
        cards: wc.sort((a, b) => byNumber(a.issue, b.issue)),
      }))
      .sort((a, b) => a.wave - b.wave);

    const current = waves.find((w) => w.wave === currentWave)?.cards ?? [];
    const pending = current.filter((c) => c.state !== 'done');
    const active = cards.some(
      (c) =>
        c.state === 'queued' || c.state === 'running' || c.state === 'review'
    );
    const status: PlanBandStatus =
      active && currentWave !== null
        ? { kind: 'running', wave: currentWave, count: current.length }
        : pending.length === 0 && approved > 0
          ? { kind: 'awaitingYou', count: approved }
          : pending.length > 0 && pending.every((c) => c.state === 'gate')
            ? { kind: 'decision', issueNumber: pending[0].issue.number }
            : { kind: 'ready' };

    bands.push({
      milestone,
      waves,
      waveCount: waves.length,
      currentWave,
      done: cards.filter((c) => c.state === 'done').length,
      total: raw.length,
      status,
    });
  }

  // Bands with something ready to start come first, finished ones last.
  const hasReady = (b: MilestoneBand) =>
    b.waves.some((w) => w.cards.some((c) => c.state === 'ready'));
  const finished = (b: MilestoneBand) => b.done === b.total;
  bands.sort(
    (a, b) =>
      Number(finished(a)) - Number(finished(b)) ||
      Number(hasReady(b)) - Number(hasReady(a)) ||
      a.milestone.localeCompare(b.milestone)
  );

  const maxWave = Math.max(
    0,
    ...bands.flatMap((b) => b.waves.map((w) => w.wave))
  );

  return {
    bands,
    loose: loose.sort(byNumber),
    awaitingMerge: awaitingMerge.sort((a, b) => byNumber(a.issue, b.issue)),
    columnCount: maxWave + 1,
  };
}
