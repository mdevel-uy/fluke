import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type {
  MilestoneBand as Band,
  PlanCardState,
} from '@/features/issues/lib/milestonePlan';
import type { WorkerTask } from '@/features/sprint/types';
import type { MilestoneRun } from 'shared/types';
import { PlanCard } from './PlanCard';
import { CollapsedSummary } from './CollapsedSummary';
import type { DecisionContext } from './DecisionDrawer';

/**
 * One milestone of the Plan view (design/mockups/fluke-v2/issues-plan.html,
 * `.band`): header with play, name, status line and progress; below it one
 * column per wave with arrows between consecutive populated waves.
 *
 * The chevron (or a click on the name) collapses the band into a status
 * summary (#664). Play / pause / Reiniciar drive the milestone run (#666).
 */

export interface MilestoneBandProps {
  band: Band;
  columnCount: number;
  taskByIssueNumber: ReadonlyMap<number, WorkerTask>;
  workerNameById: ReadonlyMap<string, string>;
  selectedIssueId?: string;
  onSelectIssue?: (issue: RepoIssue) => void;
  onDecide?: (issue: RepoIssue, context: DecisionContext) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** The milestone's run, if it was ever played (#666). */
  run?: MilestoneRun;
  onPlay?: () => void;
  onPause?: () => void;
  onReset?: () => void;
  busy?: boolean;
}

type Edge = { d: string; tone: 'done' | 'active' | 'blocked' };

const EDGE_TONE = (state: PlanCardState): Edge['tone'] =>
  state === 'done'
    ? 'done'
    : state === 'running' || state === 'review' || state === 'queued'
      ? 'active'
      : 'blocked';

const EDGE_COLOR: Record<Edge['tone'], string> = {
  done: 'hsl(var(--_success))',
  active: 'hsl(var(--md-primary))',
  blocked: 'hsl(var(--md-outline))',
};

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn(
        'size-3.5 fill-current transition-transform duration-200 motion-reduce:transition-none',
        collapsed && '-rotate-90'
      )}
    >
      <path d="M3.5 5.5 8 10l4.5-4.5 1 1L8 12 2.5 6.5z" />
    </svg>
  );
}

function PlayIcon({ kind }: { kind: 'play' | 'pause' | 'done' }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 fill-current" aria-hidden>
      {kind === 'pause' ? (
        <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
      ) : kind === 'done' ? (
        <path d="M6.2 11.6 2.6 8l1.1-1.1 2.5 2.5 6.1-6.1 1.1 1.1z" />
      ) : (
        <path d="M4 2.5v11l9-5.5z" />
      )}
    </svg>
  );
}

export function MilestoneBand({
  band,
  columnCount,
  taskByIssueNumber,
  workerNameById,
  selectedIssueId,
  onSelectIssue,
  onDecide,
  collapsed,
  onToggle,
  run,
  onPlay,
  onPause,
  onReset,
  busy,
}: MilestoneBandProps) {
  const { t } = useTranslation('common');
  const lanesRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Arrows from every card of a populated wave to every card of the next
  // populated wave, measured from the DOM so they follow wrapping titles.
  const measure = useCallback(() => {
    const lanes = lanesRef.current;
    if (!lanes) return;
    const o = lanes.getBoundingClientRect();
    const rect = (n: number) =>
      lanes.querySelector(`[data-n="${n}"]`)?.getBoundingClientRect();
    const next: Edge[] = [];
    for (let k = 0; k < band.waves.length - 1; k++) {
      for (const a of band.waves[k].cards) {
        for (const b of band.waves[k + 1].cards) {
          const A = rect(a.issue.number);
          const B = rect(b.issue.number);
          if (!A || !B) continue;
          const x1 = A.right - o.left;
          const y1 = A.top + A.height / 2 - o.top;
          const x2 = B.left - o.left - 2;
          const y2 = B.top + B.height / 2 - o.top;
          const mx = (x1 + x2) / 2;
          next.push({
            d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`,
            tone: EDGE_TONE(a.state),
          });
        }
      }
    }
    setEdges(next);
  }, [band]);

  useLayoutEffect(() => {
    measure();
    const lanes = lanesRef.current;
    if (!lanes || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(lanes);
    return () => ro.disconnect();
  }, [measure, collapsed]);

  const runActive = run?.status === 'running' || run?.status === 'waiting';
  const running = run?.status === 'running' || band.status.kind === 'running';
  const waiting = run?.status === 'waiting';
  // The decision drawer needs the wave, the milestone and the later issues
  // the decision unblocks.
  const decide = onDecide
    ? (issue: RepoIssue) => {
        const wave =
          band.waves.find((w) => w.cards.some((c) => c.issue.id === issue.id))
            ?.wave ?? null;
        onDecide(issue, {
          wave,
          milestone: band.milestone,
          unblocks: band.waves
            .filter((w) => wave !== null && w.wave > wave)
            .flatMap((w) => w.cards.map((c) => c.issue.number)),
        });
      }
    : undefined;
  const percent = band.total ? (100 * band.done) / band.total : 0;
  const markerId = (tone: Edge['tone']) =>
    `plan-arrow-${tone}-${band.milestone.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-[10px] border border-md-outline-variant bg-md-surface-container-low',
        running && 'border-md-primary/60',
        waiting && 'border-warning/60'
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center gap-3.5 bg-md-surface-container px-4 py-3',
          !collapsed && 'border-b border-md-outline-variant'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={t(
            collapsed ? 'issues.plan.expand' : 'issues.plan.collapse'
          )}
          className="grid size-7 flex-none place-items-center rounded-md text-normal hover:bg-md-on-surface/10 hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
        >
          <ChevronIcon collapsed={collapsed} />
        </button>
        <button
          type="button"
          disabled={busy || run?.status === 'done'}
          onClick={runActive ? onPause : onPlay}
          aria-label={t(runActive ? 'issues.plan.pause' : 'issues.plan.play')}
          className={cn(
            'grid size-[34px] flex-none place-items-center rounded-full border border-md-primary text-md-primary hover:bg-md-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary disabled:opacity-60',
            runActive && 'bg-md-primary text-md-on-primary hover:bg-md-primary',
            run?.status === 'done' && 'border-success text-success'
          )}
        >
          <PlayIcon
            kind={
              runActive ? 'pause' : run?.status === 'done' ? 'done' : 'play'
            }
          />
        </button>
        <div className="grid min-w-0 flex-[1_1_260px] gap-0.5">
          <h2
            onClick={onToggle}
            className="m-0 cursor-pointer text-[15px] font-semibold text-high [text-wrap:balance]"
          >
            {band.milestone}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-normal">
            <BandStatus band={band} run={run} />
          </div>
        </div>
        <div className="grid w-40 flex-none gap-1">
          <div className="h-[5px] overflow-hidden rounded-[3px] bg-md-outline-variant">
            <i
              className="block h-full bg-success transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-right font-mono text-[11px] tabular-nums text-normal">
            {t('issues.plan.merged', { done: band.done, total: band.total })}
          </span>
        </div>
        {run && onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="p-1 text-xs text-normal hover:text-high disabled:opacity-60"
          >
            {t('issues.plan.reset')}
          </button>
        )}
      </div>

      {collapsed ? (
        <CollapsedSummary
          band={band}
          taskByIssueNumber={taskByIssueNumber}
          workerNameById={workerNameById}
          onDecide={decide}
        />
      ) : (
        <div className="overflow-x-auto">
          <div
            ref={lanesRef}
            className="relative grid min-w-max gap-x-12 px-4 pb-4 pt-3.5"
            style={{ gridTemplateColumns: `repeat(${columnCount}, 280px)` }}
          >
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
            >
              <defs>
                {(['done', 'active', 'blocked'] as const).map((tone) => (
                  <marker
                    key={tone}
                    id={markerId(tone)}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0 0L8 4L0 8z" fill={EDGE_COLOR[tone]} />
                  </marker>
                ))}
              </defs>
              {edges.map((e, i) => (
                <path
                  key={i}
                  d={e.d}
                  fill="none"
                  stroke={EDGE_COLOR[e.tone]}
                  strokeWidth={1.6}
                  markerEnd={`url(#${markerId(e.tone)})`}
                />
              ))}
            </svg>

            {Array.from({ length: columnCount }, (_, k) => {
              const wave = band.waves.find((w) => w.wave === k);
              if (!wave) {
                return (
                  <div
                    key={k}
                    className="flex flex-col gap-2.5 rounded-lg border border-dashed border-md-outline-variant p-2.5"
                  >
                    <p className="m-0 flex justify-between font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-low">
                      <span>{t('issues.plan.wave', { n: k })}</span>
                      <span>—</span>
                    </p>
                  </div>
                );
              }
              const done = wave.cards.filter((c) => c.state === 'done').length;
              const allDone = done === wave.cards.length;
              const current = k === band.currentWave;
              return (
                <div
                  key={k}
                  className={cn(
                    'flex flex-col gap-2.5 rounded-lg border border-md-outline-variant bg-md-surface-container-lowest p-2.5',
                    current && 'border-md-primary/45',
                    allDone && 'opacity-75'
                  )}
                >
                  <p
                    className={cn(
                      'm-0 flex justify-between font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal',
                      current && 'text-md-primary'
                    )}
                  >
                    <span>{t('issues.plan.wave', { n: k })}</span>
                    <span className="tabular-nums">
                      {done}/{wave.cards.length}
                    </span>
                  </p>
                  {wave.cards.map((card) => {
                    const task = taskByIssueNumber.get(card.issue.number);
                    return (
                      <PlanCard
                        key={card.issue.id}
                        issue={card.issue}
                        state={card.state}
                        currentWave={band.currentWave}
                        workerName={
                          task ? workerNameById.get(task.worker_id) : undefined
                        }
                        selected={card.issue.id === selectedIssueId}
                        onSelect={onSelectIssue}
                        onDecide={decide}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function BandStatus({ band, run }: { band: Band; run?: MilestoneRun }) {
  const { t } = useTranslation('common');
  const line = (title: string, detail: string, tone: string) => (
    <>
      <b className={cn('font-medium', tone)}>{title}</b>
      <span>· {detail}</span>
    </>
  );
  const wave = run?.current_wave ?? band.currentWave;
  const inWave = (n: number | null) =>
    band.waves.find((w) => w.wave === n)?.cards.length ?? 0;

  if (run?.status === 'waiting') {
    const [kind, num] = (run.waiting_reason ?? '').split(':');
    return kind === 'failed'
      ? line(
          t('issues.plan.status.waitingTitle'),
          t('issues.plan.status.failedDetail', { n: num }),
          'text-warning'
        )
      : line(
          t('issues.plan.status.waitingDecisionTitle'),
          t('issues.plan.status.waitingDecisionDetail', { n: num }),
          'text-warning'
        );
  }
  if (run?.status === 'paused') {
    // Paused by step mode right after a wave finished.
    const previous = band.waves
      .map((w) => w.wave)
      .filter((w) => wave !== null && w < wave)
      .pop();
    return run.step_mode && previous !== undefined
      ? line(
          t('issues.plan.status.stepTitle', { n: previous }),
          t('issues.plan.status.stepDetail', { n: wave }),
          'text-high'
        )
      : line(
          t('issues.plan.status.pausedTitle'),
          t('issues.plan.status.pausedDetail'),
          'text-high'
        );
  }
  if (run?.status === 'done') {
    return line(
      t('issues.plan.status.doneTitle'),
      t('issues.plan.status.doneDetail'),
      'text-success'
    );
  }
  const s = band.status;
  if (run?.status === 'running' || s.kind === 'running') {
    return line(
      t('issues.plan.status.runningTitle', { n: wave }),
      t('issues.plan.status.runningDetail', { count: inWave(wave) }),
      'text-md-primary'
    );
  }
  return line(
    t('issues.plan.status.readyTitle'),
    s.kind === 'decision'
      ? t('issues.plan.status.gateDetail', { n: s.issueNumber })
      : `${t('issues.plan.status.waves', { count: band.waveCount })}, ${t(
          'issues.plan.status.issues',
          { count: band.total }
        )}`,
    'text-high'
  );
}
