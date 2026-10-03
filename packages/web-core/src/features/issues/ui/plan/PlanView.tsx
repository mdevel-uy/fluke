import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import { MilestoneBand } from './MilestoneBand';
import type { DecisionContext } from './DecisionDrawer';
import { instanceLabel } from '@/features/workers/model/instance';
import { PlanCard } from './PlanCard';

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
}

const TASK_TO_CARD: Record<string, PlanCardState> = {
  queued: 'queued',
  in_progress: 'running',
  waiting_user: 'running',
  in_review: 'review',
  approved: 'review',
};

const LEGEND: { key: string; className: string }[] = [
  { key: 'ready', className: 'border-success' },
  { key: 'running', className: 'border-md-primary' },
  { key: 'review', className: 'border-violet-600 dark:border-violet-400' },
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
}: PlanViewProps) {
  const { t } = useTranslation('common');
  const blockers = useIssueBlockers(repoId);
  const plan = useMemo(
    () =>
      buildMilestonePlan(issues, taskByIssueNumber, new Set(blockers.keys())),
    [issues, taskByIssueNumber, blockers]
  );
  const { data: runs = [] } = useMilestoneRuns(repoId);
  const actions = useMilestoneRunActions(repoId);
  const stepMode = usePlanStepModeStore((s) => s.stepMode);
  const busy =
    actions.play.isPending ||
    actions.pause.isPending ||
    actions.reset.isPending;
  const collapsed = usePlanCollapseStore((s) => s.collapsed);
  const toggle = usePlanCollapseStore((s) => s.toggle);
  const setVisible = usePlanCollapseStore((s) => s.setVisible);
  // Serialized so the effect only fires when the set of bands changes.
  const milestones = JSON.stringify(plan.bands.map((b) => b.milestone));
  useEffect(() => {
    setVisible(JSON.parse(milestones) as string[]);
  }, [milestones, setVisible]);

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-4 px-4 py-5">
      {plan.bands.length === 0 ? (
        <div className="px-4 py-10 text-center text-body-md text-normal">
          {t('issues.plan.empty')}
        </div>
      ) : (
        <div className="grid gap-3.5">
          {plan.bands.map((band) => (
            <MilestoneBand
              key={band.milestone}
              band={band}
              columnCount={plan.columnCount}
              taskByIssueNumber={taskByIssueNumber}
              workerNameById={workerNameById}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
              onDecide={onDecide}
              collapsed={collapsed.includes(band.milestone)}
              onToggle={() => toggle(band.milestone)}
              run={runs.find((r) => r.milestone === band.milestone)}
              onPlay={() =>
                actions.play.mutate({ milestone: band.milestone, stepMode })
              }
              onPause={() => actions.pause.mutate(band.milestone)}
              onReset={() => actions.reset.mutate(band.milestone)}
              busy={busy}
              blockers={blockers}
              onUnstick={onUnstick}
            />
          ))}
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
                  workerName={
                    task && workerNameById.get(task.worker_id)
                      ? instanceLabel(
                          workerNameById.get(task.worker_id)!,
                          task.workspace_id
                        )
                      : undefined
                  }
                  selected={issue.id === selectedIssueId}
                  onSelect={onSelectIssue}
                  blocker={blocker}
                  onUnstick={onUnstick}
                />
              );
            })}
          </div>
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
