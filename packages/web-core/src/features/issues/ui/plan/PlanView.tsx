import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Rows2, Rows4 } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import {
  buildMilestonePlan,
  type PlanCardState,
} from '@/features/issues/lib/milestonePlan';
import { usePlanCollapseStore } from '@/features/issues/model/usePlanCollapseStore';
import { useIssueBlockers } from '@/features/issues/model/useIssueBlockers';
import {
  useMilestoneRunActions,
  useMilestoneRuns,
  usePlanStepModeStore,
} from '@/features/issues/model/useMilestoneRuns';
import {
  arrangeMilestones,
  moveMilestone,
} from '@/features/issues/lib/milestoneOrder';
import { milestoneTags } from '@/features/issues/lib/milestoneTags';
import {
  useRepoMilestones,
  useSetMilestoneOpen,
} from '@/features/issues/model/useRepoMilestones';
import {
  usePlanPrefsStore,
  type PlanDensity,
} from '@/features/issues/model/usePlanPrefsStore';
import { MilestoneBand } from './MilestoneBand';
import { CompactMilestoneRow } from './CompactMilestoneRow';
import { MilestoneTagChips, type MilestoneActions } from './MilestoneControls';
import type { DecisionContext } from './DecisionDrawer';
import { instanceLabel } from '@/features/workers/model/instance';
import { PlanCard } from './PlanCard';
import { MergePrAction } from '../merge/MergePrAction';
import { useTalkToFluke } from '@/features/director/model/useMissions';

/**
 * Plan view of the Issues page (fluke v2, #663): one band per GitHub
 * milestone with its issues in columns by wave, the loose bucket below and
 * the legend. Contract: design/mockups/fluke-v2/issues-plan.html.
 */

export interface PlanViewProps {
  repoId: string;
  /** Open and closed issues: closed ones count as merged inside a band. */
  issues: RepoIssue[];
  taskByIssueNumber: ReadonlyMap<number, WorkerTask>;
  workerNameById: ReadonlyMap<string, string>;
  selectedIssueId?: string;
  onSelectIssue?: (issue: RepoIssue) => void;
  onDecide?: (issue: RepoIssue, context: DecisionContext) => void;
  /** Destrabar on a stuck card (#696). */
  onUnstick?: (issue: RepoIssue) => void;
  /** Which milestones the sidebar asks for. */
  milestoneFilter: PlanMilestoneFilter;
  /** "Show issues in list" from a milestone's menu. */
  onShowIssues?: (milestone: string) => void;
}

function DensityToggle({
  value,
  onChange,
}: {
  value: PlanDensity;
  onChange: (value: PlanDensity) => void;
}) {
  const { t } = useTranslation('common');
  const options: { v: PlanDensity; icon: typeof Rows2 }[] = [
    { v: 'bands', icon: Rows2 },
    { v: 'compact', icon: Rows4 },
  ];
  return (
    <div
      role="group"
      aria-label={t('issues.plan.density.label')}
      className="ml-auto flex overflow-hidden rounded-md border border-md-outline-variant"
    >
      {options.map(({ v, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 px-2.5 text-xs text-normal hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-md-primary',
            value === v && 'bg-md-primary/15 text-high'
          )}
        >
          <Icon className="size-3.5" />
          {t(`issues.plan.density.${v}`)}
        </button>
      ))}
    </div>
  );
}

export type PlanMilestoneFilter =
  | 'unfinished'
  | 'active'
  | 'running'
  | 'stopped'
  | 'finished';

const TASK_TO_CARD: Record<string, PlanCardState> = {
  queued: 'queued',
  in_progress: 'running',
  waiting_user: 'running',
  in_review: 'review',
  approved: 'approved',
};

const LEGEND: { key: string; className: string }[] = [
  { key: 'ready', className: 'border-success' },
  { key: 'running', className: 'border-md-primary' },
  { key: 'review', className: 'border-violet-600 dark:border-violet-400' },
  { key: 'approved', className: 'border-2 border-success' },
  { key: 'gate', className: 'border-dashed border-warning' },
  { key: 'queued', className: 'border-dashed border-md-on-surface-variant' },
  { key: 'blocked', className: 'border-md-outline' },
];

export function PlanView({
  repoId,
  issues,
  taskByIssueNumber,
  workerNameById,
  selectedIssueId,
  onSelectIssue,
  onDecide,
  onUnstick,
  milestoneFilter,
  onShowIssues,
}: PlanViewProps) {
  const { t } = useTranslation('common');
  const blockers = useIssueBlockers(repoId);
  const { data: runs = [] } = useMilestoneRuns(repoId);
  const { data: ghMilestones = [] } = useRepoMilestones(repoId);
  const setOpen = useSetMilestoneOpen(repoId);
  const talkToFluke = useTalkToFluke();
  const prefs = usePlanPrefsStore();
  const ghByTitle = useMemo(
    () => new Map(ghMilestones.map((m) => [m.title, m])),
    [ghMilestones]
  );
  const plan = useMemo(() => {
    const all = buildMilestonePlan(
      issues,
      taskByIssueNumber,
      new Set(blockers.keys())
    );
    // A milestone closed on GitHub is archived: out of the plan, listed below.
    const isArchived = (b: (typeof all.bands)[number]) =>
      ghByTitle.get(b.milestone)?.state === 'closed';
    const full = { ...all, bands: all.bands.filter((b) => !isArchived(b)) };
    const archived = all.bands.filter(isArchived);
    const isActive = (b: (typeof full.bands)[number]) => {
      const run = runs.find((r) => r.milestone === b.milestone)?.status;
      return (
        b.status.kind === 'running' ||
        // An approved PR waiting for its merge keeps the milestone active.
        all.awaitingMerge.some((a) => a.milestone === b.milestone) ||
        run === 'running' ||
        run === 'waiting'
      );
    };
    const runOf = (b: (typeof full.bands)[number]) =>
      runs.find((r) => r.milestone === b.milestone)?.status;
    const isRunning = (b: (typeof full.bands)[number]) =>
      b.status.kind === 'running' || runOf(b) === 'running';
    // Held by a person: a stuck card (conflict, question, failure...), a
    // pm:decision gate, a run waiting on the user or a PR waiting for merge.
    const isStopped = (b: (typeof full.bands)[number]) =>
      b.waves.some((w) =>
        w.cards.some((c) => c.state === 'stuck' || c.state === 'gate')
      ) ||
      runOf(b) === 'waiting' ||
      all.awaitingMerge.some((a) => a.milestone === b.milestone);
    const bands = full.bands.filter((b) =>
      milestoneFilter === 'finished'
        ? b.done === b.total
        : b.done < b.total &&
          (milestoneFilter === 'active'
            ? isActive(b)
            : milestoneFilter === 'running'
              ? isRunning(b)
              : milestoneFilter === 'stopped'
                ? isStopped(b)
                : true)
    );
    // Loose issues are open work: they only belong next to unfinished milestones.
    const loose = milestoneFilter === 'unfinished' ? full.loose : [];
    // Approved PRs waiting for a person to merge them (#759). They are not in
    // any band, so the section follows the bands shown (an unmerged PR keeps
    // its milestone unfinished) and, like the loose bucket, loose ones only
    // show under "Sin finalizar".
    const awaitingMerge = full.awaitingMerge.filter((a) =>
      a.milestone === null
        ? milestoneFilter === 'unfinished'
        : bands.some((b) => b.milestone === a.milestone)
    );
    return { ...full, bands, loose, awaitingMerge, archived };
  }, [issues, taskByIssueNumber, blockers, runs, milestoneFilter, ghByTitle]);
  const sections = useMemo(
    () => arrangeMilestones(plan.bands, prefs.starred, prefs.order),
    [plan.bands, prefs.starred, prefs.order]
  );
  const shown = [...sections.starred, ...sections.rest].map((b) => b.milestone);
  const actions = useMilestoneRunActions(repoId);
  const stepMode = usePlanStepModeStore((s) => s.stepMode);
  const busy =
    actions.play.isPending ||
    actions.pause.isPending ||
    actions.reset.isPending;
  const collapsed = usePlanCollapseStore((s) => s.collapsed);
  const toggle = usePlanCollapseStore((s) => s.toggle);
  const setVisible = usePlanCollapseStore((s) => s.setVisible);
  // Serialized so the effect only fires when the set of bands changes. In
  // screen order, so "Ejecutar todas" follows the user's arrangement.
  const milestones = JSON.stringify(shown);
  useEffect(() => {
    setVisible(JSON.parse(milestones) as string[]);
  }, [milestones, setVisible]);

  const [drag, setDrag] = useState<{ from: string; over?: string } | null>(
    null
  );
  // Compact view: the one milestone opened as a full band.
  const [opened, setOpened] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; number: number } | null>(
    null
  );
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const sameSection = (a: string, b: string) =>
    prefs.starred.includes(a) === prefs.starred.includes(b);
  const move = (from: string, to: string) => {
    if (sameSection(from, to)) {
      prefs.setOrder(moveMilestone(prefs.order, shown, from, to));
    }
  };

  const archive = (band: (typeof plan.bands)[number], number: number) => {
    const open = band.total - band.done;
    setOpen.mutate({ number, open: false });
    setOpened(null);
    setToast({
      text: open
        ? t('issues.plan.archivedOpenIssues', { count: open })
        : t('issues.plan.archived'),
      number,
    });
  };

  const actionsFor = (band: (typeof plan.bands)[number]): MilestoneActions => {
    const m = band.milestone;
    const gh = ghByTitle.get(m);
    const i = shown.indexOf(m);
    return {
      starred: prefs.starred.includes(m),
      onToggleStar: () => prefs.toggleStar(m),
      tags: milestoneTags(
        band.waves.flatMap((w) => w.cards.map((c) => c.issue))
      ),
      onArchive: gh ? () => archive(band, gh.number) : undefined,
      githubUrl: gh?.html_url,
      onShowIssues: onShowIssues ? () => onShowIssues(m) : undefined,
      onReviewWithFluke: () => {
        const nums = band.waves.flatMap((w) =>
          w.cards.map((c) => c.issue.number)
        );
        talkToFluke.mutate({
          repoId,
          issueNumbers: nums,
          prompt: t('issues.plan.reviewWithFlukeMessage', {
            milestone: m,
            issues: nums.map((n) => `#${n}`).join(', '),
          }),
        });
      },
      reorder: {
        dragging: drag?.from === m,
        over: !!drag && drag.over === m && drag.from !== m,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', m);
          setDrag({ from: m });
        },
        onDragEnd: () => setDrag(null),
        onDragOver: (e) => {
          if (!drag || !sameSection(drag.from, m)) return;
          e.preventDefault();
          if (drag.over !== m) setDrag({ ...drag, over: m });
        },
        onDrop: (e) => {
          e.preventDefault();
          if (drag) move(drag.from, m);
          setDrag(null);
        },
        onMove: (step) => {
          const to = shown[i + step];
          if (to) move(m, to);
        },
      },
    };
  };

  const renderBand = (band: (typeof plan.bands)[number]) => {
    const run = runs.find((r) => r.milestone === band.milestone);
    const common = {
      run,
      onPlay: () =>
        actions.play.mutate({ milestone: band.milestone, stepMode }),
      onPause: () => actions.pause.mutate(band.milestone),
      busy,
      onDecide,
      actions: actionsFor(band),
    };
    if (prefs.density === 'compact' && opened !== band.milestone) {
      return (
        <CompactMilestoneRow
          key={band.milestone}
          band={band}
          onOpen={() => setOpened(band.milestone)}
          {...common}
        />
      );
    }
    const compact = prefs.density === 'compact';
    return (
      <div key={band.milestone} className={cn(compact && 'my-1.5 px-1.5')}>
        <MilestoneBand
          band={band}
          columnCount={plan.columnCount}
          taskByIssueNumber={taskByIssueNumber}
          workerNameById={workerNameById}
          selectedIssueId={selectedIssueId}
          onSelectIssue={onSelectIssue}
          collapsed={!compact && collapsed.includes(band.milestone)}
          onToggle={
            compact ? () => setOpened(null) : () => toggle(band.milestone)
          }
          onReset={() => actions.reset.mutate(band.milestone)}
          blockers={blockers}
          onUnstick={onUnstick}
          {...common}
        />
      </div>
    );
  };

  const workerNameFor = (issue: RepoIssue) => {
    const task = taskByIssueNumber.get(issue.number);
    const profile = task ? workerNameById.get(task.worker_id) : undefined;
    return task && profile
      ? instanceLabel(profile, task.workspace_id)
      : undefined;
  };

  const renderSection = (
    title: string | null,
    bands: (typeof plan.bands)[number][]
  ) =>
    bands.length > 0 && (
      <section className="grid gap-2">
        {title && (
          <h3 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-low">
            {title}
          </h3>
        )}
        <div
          className={cn(
            prefs.density === 'compact'
              ? 'overflow-hidden rounded-[10px] border border-md-outline-variant bg-md-surface-container-low'
              : 'grid gap-3.5'
          )}
        >
          {bands.map(renderBand)}
        </div>
      </section>
    );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-4 px-4 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-normal">
          {t('issues.plan.milestoneCount', { count: plan.bands.length })}
        </span>
        <DensityToggle
          value={prefs.density}
          onChange={(d) => {
            prefs.setDensity(d);
            setOpened(null);
          }}
        />
      </div>
      {plan.awaitingMerge.length > 0 && (
        <section className="grid gap-2.5 rounded-[10px] border border-success/60 px-4 py-3.5">
          <h3 className="m-0 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-high">
            {t('issues.plan.awaitingYou')}
            <span className="tabular-nums text-normal">
              {plan.awaitingMerge.length}
            </span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
            {plan.awaitingMerge.map(({ issue }) => {
              const task = taskByIssueNumber.get(issue.number);
              const prNumber = task?.pr_number;
              return (
                <PlanCard
                  key={issue.id}
                  issue={issue}
                  state="approved"
                  task={task}
                  currentWave={null}
                  workerName={workerNameFor(issue)}
                  selected={issue.id === selectedIssueId}
                  onSelect={onSelectIssue}
                  footer={
                    task && prNumber != null && task.pr_state === 'open' ? (
                      <MergePrAction
                        repoId={task.repo_id}
                        prNumber={prNumber}
                        prUrl={task.pr_url}
                        title={issue.title}
                        mergeable={task.pr_mergeable}
                        ciStatus={task.pr_ci_status}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </section>
      )}
      {plan.bands.length === 0 ? (
        <div className="px-4 py-10 text-center text-body-md text-normal">
          {milestoneFilter === 'unfinished'
            ? t('issues.plan.empty')
            : t('issues.plan.milestoneFilter.empty')}
        </div>
      ) : (
        <div className="grid gap-5">
          {renderSection(
            sections.starred.length ? t('issues.plan.starred') : null,
            sections.starred
          )}
          {renderSection(
            sections.starred.length ? t('issues.plan.milestones') : null,
            sections.rest
          )}
        </div>
      )}

      {plan.loose.length > 0 && (
        <div className="grid gap-2.5 rounded-[10px] border border-dashed border-md-outline-variant px-4 py-3.5">
          <h3 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
            {t('issues.plan.loose')}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
            {plan.loose.map((issue) => {
              const task = taskByIssueNumber.get(issue.number);
              const blocker = blockers.get(issue.number);
              const state = blocker
                ? 'stuck'
                : task
                  ? TASK_TO_CARD[task.status]
                  : undefined;
              return (
                <PlanCard
                  key={issue.id}
                  issue={issue}
                  state={state ?? 'manual'}
                  currentWave={null}
                  workerName={workerNameFor(issue)}
                  selected={issue.id === selectedIssueId}
                  onSelect={onSelectIssue}
                  blocker={blocker}
                  onUnstick={onUnstick}
                  task={task}
                />
              );
            })}
          </div>
        </div>
      )}

      {plan.archived.length > 0 && (
        <section className="rounded-[10px] border border-dashed border-md-outline-variant">
          <button
            type="button"
            onClick={prefs.toggleArchived}
            aria-expanded={prefs.showArchived}
            className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13px] text-normal hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-md-primary"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform motion-reduce:transition-none',
                prefs.showArchived && 'rotate-90'
              )}
            />
            <span className="font-semibold text-high">
              {t('issues.plan.archivedSection')}
            </span>
            <span className="font-mono text-[11px]">
              {plan.archived.length}
            </span>
          </button>
          {prefs.showArchived &&
            plan.archived.map((band) => {
              const gh = ghByTitle.get(band.milestone)!;
              const open = band.total - band.done;
              return (
                <div
                  key={band.milestone}
                  className="flex flex-wrap items-center gap-3 border-t border-md-outline-variant/60 px-4 py-2.5"
                >
                  <span className="font-medium text-normal">
                    {band.milestone}
                  </span>
                  <MilestoneTagChips
                    tags={milestoneTags(
                      band.waves.flatMap((w) => w.cards.map((c) => c.issue))
                    )}
                    max={2}
                  />
                  <span className="text-xs text-low">
                    {gh.closed_at &&
                      t('issues.plan.archivedOn', {
                        date: new Date(gh.closed_at).toLocaleDateString(
                          undefined,
                          { day: 'numeric', month: 'short' }
                        ),
                      })}
                    {open > 0 &&
                      ` · ${t('issues.plan.stillOpen', { count: open })}`}
                  </span>
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-normal">
                    {t('issues.plan.merged', {
                      done: band.done,
                      total: band.total,
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={setOpen.isPending}
                    onClick={() =>
                      setOpen.mutate({ number: gh.number, open: true })
                    }
                    className="inline-flex h-7 items-center rounded-md border border-md-outline-variant px-3 text-xs text-high hover:border-md-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary disabled:opacity-60"
                  >
                    {t('issues.plan.restore')}
                  </button>
                </div>
              );
            })}
        </section>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3.5 rounded-lg border border-md-outline-variant bg-md-surface-container-high py-2.5 pl-4 pr-3 text-[13px] text-high shadow-lg"
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => {
              setOpen.mutate({ number: toast.number, open: true });
              setToast(null);
            }}
            className="inline-flex h-7 items-center rounded-md border border-md-outline-variant px-3 text-xs hover:border-md-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
          >
            {t('issues.plan.undo')}
          </button>
        </div>
      )}
      {setOpen.isError && (
        <div role="alert" className="text-xs text-md-error">
          {t('issues.plan.archiveFailed')}
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-normal">
        {LEGEND.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-2">
            <i
              className={cn(
                'h-3 w-5 rounded-[3px] border bg-md-surface-container-high',
                item.className
              )}
            />
            {t(`issues.plan.legend.${item.key}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
