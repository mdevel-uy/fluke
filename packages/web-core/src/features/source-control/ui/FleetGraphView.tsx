import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitBranch, Tag } from 'lucide-react';
import { repoApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

type FleetGraphData = Awaited<ReturnType<typeof repoApi.getGraph>>;
type GraphCommit = FleetGraphData['commits'][number];

// Same geometry as the approved mock (design/git-fleet-mock.html).
const ROW_H = 30;
const laneX = (lane: number) => 16 + lane * 15;
const GRAPH_PAGE_SIZE = 100;

// Sourcetree-style resizable column set: Graph | Description | Date |
// Author | Commit. Graph auto-sizes to the lane count until dragged.
const DEFAULT_WIDTHS = { date: 110, author: 150, hash: 76 };
type FixedColumn = keyof typeof DEFAULT_WIDTHS;

function ColumnResizeHandle({
  onResize,
}: {
  onResize: (deltaX: number) => void;
}) {
  const lastX = useRef<number | null>(null);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        lastX.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (lastX.current === null) return;
        onResize(e.clientX - lastX.current);
        lastX.current = e.clientX;
      }}
      onPointerUp={(e) => {
        lastX.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      className="absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize hover:bg-brand/50"
    />
  );
}

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
  selectedCommitOid: string | null;
  /** oid null = deselect; branches = refs known to contain the commit. */
  onSelectCommit: (oid: string | null, containingBranches: string[]) => void;
}

/**
 * SHELL-SPEC R36: fleet graph over the FULL local branch topology as a
 * Sourcetree-style table (resizable Graph/Description/Date/Author/Commit
 * columns). Lanes come from the commit DAG; the mock's semantic colors mark
 * fleet lanes while plain branches rotate the accent palette. Clicking a
 * row selects the commit (aside shows its detail) and lights up every
 * descendant chain to the tips that contain it.
 */
export function FleetGraphView({
  repoId,
  baseBranch,
  branches,
  selectedWorkspaceId,
  onSelect,
  selectedCommitOid,
  onSelectCommit,
}: FleetGraphViewProps) {
  const { t, i18n } = useTranslation('common');

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

  // Infinite history: pages of GRAPH_PAGE_SIZE keyed by offset; the layout
  // runs over everything loaded so far. The interval refetch replays every
  // loaded page (react-query semantics), so it's kept slow.
  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['repo-graph', repoId, baseBranch, tips.join(',')],
    queryFn: ({ pageParam }) =>
      repoApi.getGraph(repoId, baseBranch, tips, GRAPH_PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.has_more ? allPages.length * GRAPH_PAGE_SIZE : undefined,
    enabled: !!repoId && !!baseBranch,
    refetchInterval: 60_000,
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

  const commits = useMemo(() => {
    const seen = new Set<string>();
    const merged: GraphCommit[] = [];
    for (const page of data?.pages ?? []) {
      for (const commit of page.commits) {
        if (seen.has(commit.oid)) continue;
        seen.add(commit.oid);
        merged.push(commit);
      }
    }
    return merged;
  }, [data]);
  const baseTipOid = useMemo(
    () => commits.find((c) => c.branch === null)?.oid,
    [commits]
  );

  // Lazy loading: fetch the next page when the bottom sentinel scrolls into
  // view inside the section's scroll container.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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

  const childrenByOid = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const commit of commits) {
      for (const parent of commit.parent_oids) {
        const list = map.get(parent);
        if (list) list.push(commit.oid);
        else map.set(parent, [commit.oid]);
      }
    }
    return map;
  }, [commits]);

  // Descendant closure of a commit. Descendants are always newer than the
  // commit, so the closure is complete within the loaded pages.
  const descendantClosure = (oid: string): Set<string> => {
    const set = new Set<string>([oid]);
    const queue = [oid];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const child of childrenByOid.get(current) ?? []) {
        if (set.has(child)) continue;
        set.add(child);
        queue.push(child);
      }
    }
    return set;
  };

  const highlightSet = useMemo(() => {
    if (!selectedCommitOid || !rowIndexByOid.has(selectedCommitOid)) {
      return null;
    }
    return descendantClosure(selectedCommitOid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCommitOid, childrenByOid, rowIndexByOid]);

  const commitByOid = useMemo(
    () => new Map(commits.map((c) => [c.oid, c])),
    [commits]
  );

  const handleRowClick = (commit: GraphCommit, rowFleet?: FleetBranch) => {
    if (rowFleet) onSelect(rowFleet.workspace.id);
    if (selectedCommitOid === commit.oid) {
      onSelectCommit(null, []);
      return;
    }
    const closure = descendantClosure(commit.oid);
    const containing = new Set<string>();
    for (const oid of closure) {
      for (const name of commitByOid.get(oid)?.tip_of ?? []) {
        containing.add(name);
      }
      if (oid === baseTipOid) containing.add(baseBranch);
    }
    onSelectCommit(commit.oid, [...containing].sort());
  };

  // Column widths: graph tracks the lane count until manually resized.
  const [graphColWidth, setGraphColWidth] = useState<number | null>(null);
  const [fixedWidths, setFixedWidths] =
    useState<Record<FixedColumn, number>>(DEFAULT_WIDTHS);
  const graphW = graphColWidth ?? gutterWidth;
  const gridTemplateColumns = `${graphW}px minmax(220px,1fr) ${fixedWidths.date}px ${fixedWidths.author}px ${fixedWidths.hash}px`;

  const resizeGraph = (dx: number) =>
    setGraphColWidth((prev) =>
      Math.min(Math.max((prev ?? gutterWidth) + dx, 40), 600)
    );
  const resizeFixed = (key: FixedColumn) => (dx: number) =>
    setFixedWidths((prev) => ({
      ...prev,
      [key]: Math.min(Math.max(prev[key] + dx, 56), 400),
    }));

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [i18n.language]
  );

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
    const colorOfLane = (l: number): string => {
      const fleet = laneColor.get(l);
      if (fleet) return fleet;
      if (l === baseLane) return 'text-border-strong';
      return LANE_PALETTE[l % LANE_PALETTE.length];
    };
    for (const parentOid of commit.parent_oids) {
      const j = rowIndexByOid.get(parentOid);
      if (j === undefined) continue;
      const parentLane = rows[j].lane;
      const xp = laneX(parentLane);
      const yp = rowY(j);
      const colorClass =
        lane >= parentLane ? colorOfLane(lane) : colorOfLane(parentLane);
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
      const edgeDimmed =
        highlightSet !== null &&
        !(highlightSet.has(commit.oid) && highlightSet.has(parentOid));
      edges.push(
        <path
          key={`${commit.oid}-${parentOid}`}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={edgeDimmed ? 1.75 : highlightSet ? 2.25 : 1.75}
          className={cn(
            colorClass,
            'transition-opacity',
            edgeDimmed && 'opacity-15'
          )}
        />
      );
    }

    const isBase = commit.branch === null;
    const radius = isBase && commit.tip_of.length === 0 ? 3.2 : 4.2;
    const dotClass =
      lane === baseLane && !laneColor.has(lane) ? 'text-low' : colorOfLane(lane);
    const dotDimmed = highlightSet !== null && !highlightSet.has(commit.oid);
    dots.push(
      <circle
        key={commit.oid}
        cx={xc}
        cy={yc}
        r={commit.oid === selectedCommitOid ? radius + 1 : radius}
        fill="currentColor"
        className={cn(dotClass, 'transition-opacity', dotDimmed && 'opacity-15')}
      />
    );
    if (commit.oid === selectedCommitOid) {
      dots.push(
        <circle
          key={`${commit.oid}-sel-ring`}
          cx={xc}
          cy={yc}
          r={radius + 3.6}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className={dotClass}
        />
      );
    }
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
          className={cn(
            dotClass,
            'transition-opacity',
            dotDimmed && 'opacity-15'
          )}
        />
      );
    }
  });

  const headerCell = (label: string, handle?: React.ReactNode) => (
    <div className="relative flex min-w-0 items-center px-2">
      <span className="truncate">{label}</span>
      {handle}
    </div>
  );

  return (
    <div className="min-w-fit">
      {/* Table header (R37 table treatment): sticky, resizable columns. */}
      <div
        className="sticky top-0 z-20 grid h-[26px] select-none border-b border-md-outline-variant bg-md-surface-container-low text-[11px] font-medium uppercase tracking-wider text-low"
        style={{ gridTemplateColumns }}
      >
        {headerCell(
          t('sourceControl.graph.columns.graph', { defaultValue: 'Graph' }),
          <ColumnResizeHandle onResize={resizeGraph} />
        )}
        {headerCell(
          t('sourceControl.graph.columns.description', {
            defaultValue: 'Description',
          })
        )}
        {headerCell(
          t('sourceControl.graph.columns.date', { defaultValue: 'Date' }),
          <ColumnResizeHandle onResize={resizeFixed('date')} />
        )}
        {headerCell(
          t('sourceControl.graph.columns.author', { defaultValue: 'Author' }),
          <ColumnResizeHandle onResize={resizeFixed('author')} />
        )}
        {headerCell(
          t('sourceControl.graph.columns.commit', { defaultValue: 'Commit' }),
          <ColumnResizeHandle onResize={resizeFixed('hash')} />
        )}
      </div>

      <div className="relative">
        {/* Lane gutter, clipped to the Graph column. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 overflow-hidden"
          style={{ width: graphW }}
        >
          <svg width={gutterWidth} height={height} aria-hidden>
            {edges}
            {dots}
          </svg>
        </div>

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
            commit.oid === selectedCommitOid ||
            (!!rowFleet && rowFleet.workspace.id === selectedWorkspaceId);
          const rowDimmed =
            highlightSet !== null && !highlightSet.has(commit.oid);

          return (
            <div
              key={commit.oid}
              role="button"
              onClick={() => handleRowClick(commit, rowFleet)}
              className={cn(
                'grid h-[30px] cursor-pointer items-center text-sm hover:bg-secondary/60',
                isSelected && 'bg-sel',
                rowDimmed && 'opacity-50'
              )}
              style={{ gridTemplateColumns }}
            >
              <div aria-hidden />
              <div className="flex min-w-0 items-center gap-2 overflow-hidden px-1.5">
                <span
                  className={cn(
                    'min-w-0 flex-none truncate',
                    commit.branch === null && commit.tip_of.length === 0
                      ? 'text-low'
                      : 'text-high'
                  )}
                  style={{ maxWidth: '60%' }}
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
              </div>
              <div className="truncate px-2 text-[11px] text-low">
                {dateFormat.format(new Date(commit.committed_at))}
              </div>
              <div className="truncate px-2 text-[11px] text-low">
                {commit.author}
              </div>
              <div className="truncate px-2 font-mono text-[11px] text-low">
                {commit.short_oid}
              </div>
            </div>
          );
        })}
        {hasNextPage && (
          <div
            ref={sentinelRef}
            className="flex h-[30px] items-center justify-center text-xs text-low"
          >
            {isFetchingNextPage
              ? t('sourceControl.graph.loadingMore', {
                  defaultValue: 'Loading older commits…',
                })
              : ''}
          </div>
        )}
      </div>
    </div>
  );
}
