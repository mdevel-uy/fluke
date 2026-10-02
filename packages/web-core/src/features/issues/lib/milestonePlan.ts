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
  | 'done';

export interface PlanCard {
  issue: RepoIssue;
  wave: number;
  state: PlanCardState;
}

export interface PlanWave {
  wave: number;
  cards: PlanCard[];
}

export type PlanBandStatus =
  | { kind: 'ready' }
  | { kind: 'decision'; issueNumber: number }
  | { kind: 'running'; wave: number; count: number };

export interface MilestoneBand {
  milestone: string;
  /** Populated waves only, ascending. Gaps are drawn as empty columns. */
  waves: PlanWave[];
  /** Number of populated waves ("N waves" in the band status line). */
  waveCount: number;
  /** Lowest wave that still has something not merged; null when all are. */
  currentWave: number | null;
  done: number;
  total: number;
  status: PlanBandStatus;
}

export interface MilestonePlan {
  bands: MilestoneBand[];
  /** Open issues without a milestone or without a usable `wave:`. */
  loose: RepoIssue[];
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
  approved: 'review',
  done: 'done',
};

const byNumber = (a: RepoIssue, b: RepoIssue) => a.number - b.number;

/**
 * `taskByIssueNumber` holds the task that represents each issue (the active
 * one, otherwise a finished one). A `failed` task reads as no task: the issue
 * is back to waiting for a dispatch.
 */
export function buildMilestonePlan(
  issues: readonly RepoIssue[],
  taskByIssueNumber: ReadonlyMap<number, TaskLike>
): MilestonePlan {
  const loose: RepoIssue[] = [];
  const byMilestone = new Map<string, RepoIssue[]>();

  for (const issue of issues) {
    const wave = waveNumber(issue.labels);
    if (!issue.milestone || wave === null) {
      if (issue.state === 'open') loose.push(issue);
      continue;
    }
    const list = byMilestone.get(issue.milestone);
    if (list) list.push(issue);
    else byMilestone.set(issue.milestone, [issue]);
  }

  const bands: MilestoneBand[] = [];
  for (const [milestone, list] of byMilestone) {
    if (!list.some((i) => i.state === 'open')) continue;

    const raw = list.map((issue) => {
      const task = taskByIssueNumber.get(issue.number);
      const taskState = task ? TASK_STATE[task.status] : undefined;
      return {
        issue,
        wave: waveNumber(issue.labels)!,
        taskState: issue.state !== 'open' ? 'done' : taskState,
      };
    });

    const open = raw.filter((c) => c.taskState !== 'done');
    const currentWave = open.length
      ? Math.min(...open.map((c) => c.wave))
      : null;

    const cards: PlanCard[] = raw.map((c) => ({
      issue: c.issue,
      wave: c.wave,
      state:
        c.taskState ??
        (c.wave !== currentWave
          ? 'blocked'
          : c.issue.labels.some((l) => l.name === PM_DECISION_LABEL)
            ? 'gate'
            : 'ready'),
    }));

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
        : pending.length > 0 && pending.every((c) => c.state === 'gate')
          ? { kind: 'decision', issueNumber: pending[0].issue.number }
          : { kind: 'ready' };

    bands.push({
      milestone,
      waves,
      waveCount: waves.length,
      currentWave,
      done: cards.filter((c) => c.state === 'done').length,
      total: cards.length,
      status,
    });
  }

  // Bands with something ready to start come first.
  const hasReady = (b: MilestoneBand) =>
    b.waves.some((w) => w.cards.some((c) => c.state === 'ready'));
  bands.sort(
    (a, b) =>
      Number(hasReady(b)) - Number(hasReady(a)) ||
      a.milestone.localeCompare(b.milestone)
  );

  const maxWave = Math.max(
    0,
    ...bands.flatMap((b) => b.waves.map((w) => w.wave))
  );

  return { bands, loose: loose.sort(byNumber), columnCount: maxWave + 1 };
}
