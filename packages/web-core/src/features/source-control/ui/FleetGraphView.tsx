import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitBranch, Tag } from 'lucide-react';
import { repoApi } from '@/shared/lib/api';
import { formatElapsed } from '@/shared/components/ui-new/aside/primitives';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

type FleetGraphData = Awaited<ReturnType<typeof repoApi.getGraph>>;
type GraphCommit = FleetGraphData['commits'][number];

// Same geometry as the approved mock (design/git-fleet-mock.html).
const ROW_H = 30;
const laneX = (lane: number) => 16 + lane * 15;
const GRAPH_LIMIT = 150;

function fleetColorClass(branch: FleetBranch): string {
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

// Sourcetree-style lane rainbow for branches without a workspace, built
// from the theme's own accent tokens; fleet lanes override with their
// semantic state color and the base lane stays neutral.
const LANE_PALETTE = [
  'text-brand-on-surface',
  'text-merged',
  'text-warning',
  'text-success',
  'text-info',
  'text-error',
];

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

interface LayoutRow {
  commit: GraphCommit;
  lane: number;
}

/**
 * DAG lane assignment, git-log--graph style: each commit takes the leftmost
 * lane expecting it (lanes expecting the same commit merge into it), its
 * first parent keeps the lane, extra merge parents reserve lanes to the
 * right. Works on newest-first input; date skew just opens a fresh lane.
 */
function computeLayout(
  commits: GraphCommit[],
  pinnedTipOid?: string
): {
  rows: LayoutRow[];
  laneByOid: Map<string, number>;
  laneCount: number;
} {
  const present = new Set(commits.map((c) => c.oid));
  // Pin the base head to lane 0 so the main line stays leftmost — newer
  // branch tips would otherwise grab the left lanes under date ordering.
  const reserved: (string | null)[] = [pinnedTipOid ?? null];
  const laneByOid = new Map<string, number>();
  let laneCount = 1;

  const rows = commits.map((commit) => {
    let lane = reserved.indexOf(commit.oid);
    if (lane === -1) {
      lane = reserved.indexOf(null);
      if (lane === -1) {
        lane = reserved.length;
        reserved.push(null);
      }
    }
    for (let i = 0; i < reserved.length; i++) {
      if (reserved[i] === commit.oid) reserved[i] = null;
    }
    laneByOid.set(commit.oid, lane);

    const parents = commit.parent_oids.filter((p) => present.has(p));
    if (parents.length > 0) {
      reserved[lane] = parents[0];
      for (const parent of parents.slice(1)) {
        if (reserved.includes(parent)) continue;
        let free = -1;
        for (let i = lane + 1; i < reserved.length; i++) {
          if (reserved[i] === null) {
            free = i;
            break;
          }
        }
        if (free === -1) {
          free = reserved.length;
          reserved.push(null);
        }
        reserved[free] = parent;
      }
    } else {
      reserved[lane] = null;
    }

    laneCount = Math.max(laneCount, reserved.length);
    return { commit, lane };
  });

  return { rows, laneByOid, laneCount };
}

interface FleetGraphViewProps {
  repoId: string;
  baseBranch: string;
  branches: FleetBranch[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
}

/**
 * SHELL-SPEC R36: fleet graph over the FULL local branch topology — lanes
 * come from the commit DAG (merge curves included, Sourcetree-style), the
 * mock's semantic colors mark fleet lanes (running/attention/conflict/
 * merged) while plain branches stay neutral. Clicking a fleet branch row
 * selects it (master-detail sync with sidebar/aside).
 */
export function FleetGraphView({
  repoId,
  baseBranch,
  branches,
  selectedWorkspaceId,
  onSelect,
}: FleetGraphViewProps) {
  const { t } = useTranslation('common');

  // All local branches ride along as tips so the whole topology shows up,
  // not just workspace-backed branches. Shares the sidebar's query cache.
  const { data: allBranches } = useQuery({
    queryKey: ['repo-branches', repoId],
    queryFn: () => repoApi.getBranches(repoId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const tips = useMemo(() => {
    const names = new Set(branches.map((b) => b.workspace.branch));
    for (const b of allBranches ?? []) {
      if (!b.is_remote) names.add(b.name);
    }
    names.delete(baseBranch);
    return [...names].sort();
  }, [branches, allBranches, baseBranch]);

  const { data, isLoading } = useQuery({
    queryKey: ['repo-graph', repoId, baseBranch, tips.join(',')],
    queryFn: () => repoApi.getGraph(repoId, baseBranch, tips, GRAPH_LIMIT),
    enabled: !!repoId && !!baseBranch,
    refetchInterval: 30_000,
  });

  // Inline tag chips: tag target oid → names. Shares the sidebar's cache.
  const { data: repoTags } = useQuery({
    queryKey: ['repo-tags', repoId],
    queryFn: () => repoApi.getTags(repoId),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  const tagsByOid = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tag of repoTags ?? []) {
      const list = map.get(tag.target_oid);
      if (list) list.push(tag.name);
      else map.set(tag.target_oid, [tag.name]);
    }
    return map;
  }, [repoTags]);

  const fleetByBranch = useMemo(() => {
    const map = new Map<string, FleetBranch>();
    for (const fb of branches) map.set(fb.workspace.branch, fb);
    return map;
  }, [branches]);

  const commits = useMemo(() => data?.commits ?? [], [data]);
  const baseTipOid = useMemo(
    () => commits.find((c) => c.branch === null)?.oid,
    [commits]
  );

  const { rows, laneByOid, laneCount } = useMemo(
    () => computeLayout(commits, baseTipOid),
    [commits, baseTipOid]
  );

  // Fleet branches tint their tip's lane with the mock's state colors; every
  // other lane stays neutral slate.
  const laneColor = useMemo(() => {
    const map = new Map<number, string>();
    for (const commit of commits) {
      for (const name of commit.tip_of) {
        const fleet = fleetByBranch.get(name);
        if (!fleet) continue;
        const lane = laneByOid.get(commit.oid);
        if (lane !== undefined && !map.has(lane)) {
          map.set(lane, fleetColorClass(fleet));
        }
      }
    }
    return map;
  }, [commits, fleetByBranch, laneByOid]);

  const gutterWidth = Math.max(laneX(laneCount) + 12, 60);
  const rowIndexByOid = useMemo(
    () => new Map(rows.map((r, i) => [r.commit.oid, i])),
    [rows]
  );
  const baseLane = baseTipOid ? (laneByOid.get(baseTipOid) ?? 0) : 0;

  const colorOfLane = (lane: number): string => {
    const fleet = laneColor.get(lane);
    if (fleet) return fleet;
    if (lane === baseLane) return 'text-border-strong';
    return LANE_PALETTE[lane % LANE_PALETTE.length];
  };

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

  const height = rows.length * ROW_H;
  const rowY = (index: number) => index * ROW_H + ROW_H / 2;

  const edges: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];
  rows.forEach((row, i) => {
    const { commit, lane } = row;
    const xc = laneX(lane);
    const yc = rowY(i);
    for (const parentOid of commit.parent_oids) {
      const j = rowIndexByOid.get(parentOid);
      if (j === undefined) continue;
      const parentLane = rows[j].lane;
      const xp = laneX(parentLane);
      const yp = rowY(j);
      const colorClass =
        lane === parentLane
          ? colorOfLane(lane)
          : lane > parentLane
            ? colorOfLane(lane)
            : colorOfLane(parentLane);
      let d: string;
      if (lane === parentLane) {
        d = `M ${xc} ${yc} L ${xp} ${yp}`;
      } else if (lane > parentLane) {
        // Branch lane descending to its fork point.
        const yb = yp - ROW_H * 0.8;
        d = `M ${xc} ${yc} L ${xc} ${yb} C ${xc} ${yb + 12}, ${xp} ${yp - 12}, ${xp} ${yp}`;
      } else {
        // Merge: this lane collects one from the right.
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
    const radius = isBase && commit.tip_of.length === 0 ? 3.2 : 4.2;
    const dotClass =
      lane === baseLane && !laneColor.has(lane)
        ? 'text-low'
        : colorOfLane(lane);
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
    if (commit.tip_of.length > 0) {
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
      {rows.map(({ commit }) => {
        const fleetTips = commit.tip_of
          .map((name) => fleetByBranch.get(name))
          .filter((fb): fb is FleetBranch => !!fb);
        const plainTips = commit.tip_of.filter(
          (name) => !fleetByBranch.has(name)
        );
        const rowFleet =
          (commit.branch ? fleetByBranch.get(commit.branch) : undefined) ??
          fleetTips[0];
        const isSelected =
          !!rowFleet && rowFleet.workspace.id === selectedWorkspaceId;

        return (
          <div
            key={commit.oid}
            role={rowFleet ? 'button' : undefined}
            onClick={
              rowFleet ? () => onSelect(rowFleet.workspace.id) : undefined
            }
            className={cn(
              'flex h-[30px] items-center gap-2 pr-3 text-sm',
              rowFleet && 'cursor-pointer hover:bg-secondary/60',
              isSelected && 'bg-sel'
            )}
            style={{ paddingLeft: gutterWidth + 6 }}
          >
            <span
              className={cn(
                'min-w-0 flex-none truncate',
                commit.branch === null && commit.tip_of.length === 0
                  ? 'text-low'
                  : 'text-high'
              )}
              style={{ maxWidth: '46%' }}
              title={commit.summary}
            >
              {commit.summary}
            </span>
            {fleetTips.map((fleet) => (
              <span
                key={fleet.workspace.id}
                className={cn(
                  'flex-none rounded border border-current px-1 font-mono text-[10px] leading-4',
                  fleetColorClass(fleet)
                )}
              >
                {fleet.workspace.branch}
              </span>
            ))}
            {plainTips.map((name) => (
              <span
                key={name}
                className="flex-none rounded border border-border-strong px-1 font-mono text-[10px] leading-4 text-low"
              >
                {name}
              </span>
            ))}
            {(tagsByOid.get(commit.oid) ?? []).map((tag) => (
              <span
                key={`tag-${tag}`}
                className="flex flex-none items-center gap-0.5 rounded border border-warning/50 bg-warning/10 px-1 font-mono text-[10px] leading-4 text-warning"
              >
                <Tag className="h-2.5 w-2.5" strokeWidth={1.75} />
                {tag}
              </span>
            ))}
            {commit.oid === baseTipOid && (
              <span className="flex-none rounded border border-border-strong bg-secondary px-1 font-mono text-[10px] leading-4 text-normal">
                {baseBranch}
              </span>
            )}
            {fleetTips.map((fleet) => {
              const tag = stateTag(fleet);
              return (
                <span
                  key={`${fleet.workspace.id}-tag`}
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
