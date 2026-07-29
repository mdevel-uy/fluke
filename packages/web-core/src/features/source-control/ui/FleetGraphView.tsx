import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitBranch } from 'lucide-react';
import { repoApi } from '@/shared/lib/api';
import { formatElapsed } from '@/shared/components/ui-new/aside/primitives';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

type FleetGraphData = Awaited<ReturnType<typeof repoApi.getGraph>>;
type GraphCommit = FleetGraphData['commits'][number];

// Same geometry as the approved mock (design/git-fleet-mock.html).
const ROW_H = 30;
const laneX = (lane: number) => 16 + lane * 15;

interface LaneInfo {
  lane: number;
  /** text-* color class — SVG strokes/fills use currentColor. */
  colorClass: string;
  branch: FleetBranch;
}

function laneColorClass(branch: FleetBranch): string {
  if (branch.attentionReason === 'conflict') return 'text-error';
  if (branch.group === 'attention') return 'text-warning';
  if (branch.group === 'running') return 'text-brand-on-surface';
  if (branch.group === 'merged') return 'text-merged';
  return 'text-border-strong';
}

const OP_LABEL: Record<string, string> = {
  rebase: 'rebase',
  merge: 'merge',
  cherry_pick: 'cherry-pick',
  revert: 'revert',
};

function stateTag(branch: FleetBranch): { label: string; className: string } {
  const ws = branch.workspace;
  if (branch.attentionReason === 'conflict') {
    const op = OP_LABEL[branch.primaryStatus?.conflict_op ?? 'rebase'];
    return { label: `${op} conflict`, className: 'bg-error/10 text-error' };
  }
  if (branch.group === 'merged') {
    return {
      label: ws.prNumber ? `Merged · PR #${ws.prNumber}` : 'Merged',
      className: 'bg-merged/10 text-merged',
    };
  }
  if (branch.group === 'running') {
    return {
      label: ws.workerName ? `Running · ${ws.workerName}` : 'Running',
      className: 'bg-brand/10 text-brand-on-surface',
    };
  }
  if (branch.attentionReason === 'review') {
    return {
      label: ws.prNumber ? `PR #${ws.prNumber} · review` : 'Needs review',
      className: 'bg-warning/10 text-warning',
    };
  }
  if (branch.attentionReason === 'approval') {
    return { label: 'Needs approval', className: 'bg-warning/10 text-warning' };
  }
  if (branch.attentionReason === 'stalled') {
    return { label: 'Stalled', className: 'bg-warning/10 text-warning' };
  }
  if (branch.attentionReason === 'activity') {
    return { label: 'New activity', className: 'bg-warning/10 text-warning' };
  }
  return { label: 'Idle', className: 'bg-secondary text-low' };
}

interface FleetGraphViewProps {
  repoId: string;
  baseBranch: string;
  branches: FleetBranch[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
}

/**
 * SHELL-SPEC R36: fleet graph — the base branch as neutral lane 0 plus one
 * colored lane per attempt branch, workspace state chip over each head.
 * Clicking a branch row selects it (master-detail sync with sidebar/aside).
 */
export function FleetGraphView({
  repoId,
  baseBranch,
  branches,
  selectedWorkspaceId,
  onSelect,
}: FleetGraphViewProps) {
  const { t } = useTranslation('common');

  const tips = useMemo(
    () => [...new Set(branches.map((b) => b.workspace.branch))],
    [branches]
  );

  const { data, isLoading } = useQuery({
    queryKey: ['repo-graph', repoId, baseBranch, tips.join(',')],
    queryFn: () => repoApi.getGraph(repoId, baseBranch, tips),
    enabled: !!repoId && !!baseBranch,
    refetchInterval: 30_000,
  });

  // Lanes follow the sidebar's group order: attention, running, idle, merged.
  const lanes = useMemo(() => {
    const order: FleetBranch['group'][] = [
      'attention',
      'running',
      'idle',
      'merged',
    ];
    const map = new Map<string, LaneInfo>();
    let lane = 1;
    for (const group of order) {
      for (const branch of branches.filter((b) => b.group === group)) {
        if (map.has(branch.workspace.branch)) continue;
        map.set(branch.workspace.branch, {
          lane,
          colorClass: laneColorClass(branch),
          branch,
        });
        lane += 1;
      }
    }
    return map;
  }, [branches]);

  const commits = data?.commits ?? [];
  const gutterWidth = Math.max(laneX(lanes.size) + 12, 60);

  const indexByOid = useMemo(
    () => new Map(commits.map((c, i) => [c.oid, i])),
    [commits]
  );

  const laneOf = (commit: GraphCommit): number =>
    commit.branch ? (lanes.get(commit.branch)?.lane ?? 0) : 0;
  const colorOf = (commit: GraphCommit): string =>
    commit.branch
      ? (lanes.get(commit.branch)?.colorClass ?? 'text-border-strong')
      : 'text-border-strong';

  const baseTipIndex = commits.findIndex((c) => c.branch === null);

  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-low">
        {t('sourceControl.graph.loading', {
          defaultValue: 'Walking the fleet graph…',
        })}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <GitBranch className="h-8 w-8 text-low" strokeWidth={1.25} />
        <div className="text-sm text-low">
          {t('sourceControl.graph.empty', {
            defaultValue: 'No commits to show for this repo.',
          })}
        </div>
      </div>
    );
  }

  const height = commits.length * ROW_H;
  const rowY = (index: number) => index * ROW_H + ROW_H / 2;

  const edges: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];
  commits.forEach((commit, i) => {
    const xc = laneX(laneOf(commit));
    const yc = rowY(i);
    for (const parentOid of commit.parent_oids) {
      const j = indexByOid.get(parentOid);
      if (j === undefined) continue;
      const parent = commits[j];
      const xp = laneX(laneOf(parent));
      const yp = rowY(j);
      const childLane = laneOf(commit);
      const parentLane = laneOf(parent);
      const colorClass =
        childLane === parentLane
          ? colorOf(commit)
          : childLane > parentLane
            ? colorOf(commit)
            : colorOf(parent);
      let d: string;
      if (childLane === parentLane) {
        d = `M ${xc} ${yc} L ${xp} ${yp}`;
      } else if (childLane > parentLane) {
        // Branch lane descending to its fork point on the base.
        const yb = yp - ROW_H * 0.8;
        d = `M ${xc} ${yc} L ${xc} ${yb} C ${xc} ${yb + 12}, ${xp} ${yp - 12}, ${xp} ${yp}`;
      } else {
        // Merge: the base collects a branch.
        const yb = yc + ROW_H * 0.8;
        d = `M ${xc} ${yc} C ${xc} ${yc + 12}, ${xp} ${yb - 12}, ${xp} ${yb} L ${xp} ${yp}`;
      }
      edges.push(
        <path
          key={`${commit.oid}-${parentOid}`}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          className={colorClass}
        />
      );
    }

    const isBase = commit.branch === null;
    const radius = isBase ? 3.2 : 4.2;
    const dotClass = isBase ? 'text-low' : colorOf(commit);
    dots.push(
      <circle
        key={commit.oid}
        cx={xc}
        cy={yc}
        r={radius}
        fill="currentColor"
        className={dotClass}
      />
    );
    const isFleetTip = commit.tip_of.some((name) => lanes.has(name));
    if (isFleetTip) {
      dots.push(
        <circle
          key={`${commit.oid}-ring`}
          cx={xc}
          cy={yc}
          r={radius + 2.6}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.35}
          strokeWidth={1.5}
          className={dotClass}
        />
      );
    }
  });

  return (
    <div className="relative min-w-fit">
      <svg
        width={gutterWidth}
        height={height}
        aria-hidden
        className="absolute left-0 top-0"
      >
        {edges}
        {dots}
      </svg>
      {commits.map((commit) => {
        const laneInfo = commit.branch ? lanes.get(commit.branch) : undefined;
        const tipBranches = commit.tip_of
          .map((name) => lanes.get(name))
          .filter((info): info is LaneInfo => !!info);
        const rowBranch = laneInfo ?? tipBranches[0];
        const isSelected =
          !!rowBranch &&
          rowBranch.branch.workspace.id === selectedWorkspaceId;
        const isBaseTip =
          commit.branch === null &&
          indexByOid.get(commit.oid) === baseTipIndex;

        return (
          <div
            key={commit.oid}
            role={rowBranch ? 'button' : undefined}
            onClick={
              rowBranch
                ? () => onSelect(rowBranch.branch.workspace.id)
                : undefined
            }
            className={cn(
              'flex h-[30px] items-center gap-2 pr-3 text-sm',
              rowBranch && 'cursor-pointer hover:bg-secondary/60',
              isSelected && 'bg-sel'
            )}
            style={{ paddingLeft: gutterWidth + 6 }}
          >
            <span
              className={cn(
                'min-w-0 flex-none truncate',
                commit.branch === null ? 'text-low' : 'text-high'
              )}
              style={{ maxWidth: '46%' }}
              title={commit.summary}
            >
              {commit.summary}
            </span>
            {tipBranches.map((info) => (
              <span
                key={info.branch.workspace.id}
                className={cn(
                  'flex-none rounded border border-current px-1 font-mono text-[10px] leading-4',
                  info.colorClass
                )}
              >
                {info.branch.workspace.branch}
              </span>
            ))}
            {isBaseTip && (
              <span className="flex-none rounded border border-border-strong px-1 font-mono text-[10px] leading-4 text-low">
                {baseBranch}
              </span>
            )}
            {tipBranches.map((info) => {
              const tag = stateTag(info.branch);
              return (
                <span
                  key={`${info.branch.workspace.id}-tag`}
                  className={cn(
                    'flex-none rounded px-1.5 py-px text-[10px] font-medium',
                    tag.className
                  )}
                >
                  {tag.label}
                </span>
              );
            })}
            <span className="flex-1" />
            <span className="flex-none text-[11px] text-low">
              {commit.author}
              {' · '}
              {formatElapsed(commit.committed_at)}
            </span>
            <span className="flex-none font-mono text-[11px] text-low">
              {commit.short_oid}
            </span>
          </div>
        );
      })}
    </div>
  );
}
