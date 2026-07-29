import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Tag } from 'lucide-react';
import type { GitBranch } from 'shared/types';
import { repoApi } from '@/shared/lib/api';
import { SidebarSection } from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

interface PathNode<T> {
  /** Segment shown as the row label. */
  name: string;
  /** Full path up to this node (folder key). */
  path: string;
  children: PathNode<T>[];
  /** Present when this exact path is an item (a node can be both). */
  value?: T;
}

// Branches can't collide folder-vs-leaf (git forbids it), but tags split on
// "-" can: `desktop` and `desktop-latest` coexist — the node then carries
// both a value and children.
function buildPathTree<T>(
  items: T[],
  getName: (item: T) => string,
  separator: string
): PathNode<T>[] {
  const root: PathNode<T> = { name: '', path: '', children: [] };
  for (const item of items) {
    const parts = getName(item).split(separator);
    let node = root;
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}${separator}${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path, children: [] };
        node.children.push(child);
      }
      if (index === parts.length - 1) child.value = item;
      node = child;
    });
  }
  const sortChildren = (node: PathNode<T>) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root.children;
}

function countLeaves<T>(node: PathNode<T>): number {
  let total = node.value ? 1 : 0;
  for (const child of node.children) total += countLeaves(child);
  return total;
}

const FLEET_DOT: Record<FleetBranch['group'], string> = {
  attention: 'bg-warning',
  running: 'bg-brand-on-surface animate-pulse',
  idle: 'bg-border-strong',
  merged: 'bg-merged',
};

function FolderRow({
  name,
  count,
  depth,
  isOpen,
  onToggle,
}: {
  name: string;
  count: number;
  depth: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ paddingLeft: 16 + depth * 14 }}
      className="flex h-[22px] w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-sm text-normal hover:bg-secondary"
    >
      {isOpen ? (
        <ChevronDown className="h-3 w-3 flex-none text-low" />
      ) : (
        <ChevronRight className="h-3 w-3 flex-none text-low" />
      )}
      <span className="min-w-0 truncate">{name}</span>
      <span className="flex-none text-[11px] text-low">{count}</span>
    </button>
  );
}

function useExpandedSet() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return { expanded, toggle };
}

interface SourceControlBranchesSectionsProps {
  repoId: string | null;
  fleetBranches: FleetBranch[];
  onSelectWorkspace: (workspaceId: string) => void;
}

/**
 * Sourcetree-style Branches (slash-nested) and Tags (dash-nested) trees for
 * the Source control sidebar. Branch leaves that back an active workspace
 * show their fleet dot and select that workspace on click.
 */
export function SourceControlBranchesSections({
  repoId,
  fleetBranches,
  onSelectWorkspace,
}: SourceControlBranchesSectionsProps) {
  const { t } = useTranslation('common');
  const branchesExpanded = useExpandedSet();
  const tagsExpanded = useExpandedSet();

  const { data: allBranches } = useQuery({
    queryKey: ['repo-branches', repoId],
    queryFn: () => repoApi.getBranches(repoId!),
    enabled: !!repoId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: tags } = useQuery({
    queryKey: ['repo-tags', repoId],
    queryFn: () => repoApi.getTags(repoId!),
    enabled: !!repoId,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });

  const localBranches = useMemo(
    () => (allBranches ?? []).filter((b) => !b.is_remote),
    [allBranches]
  );
  const branchTree = useMemo(
    () => buildPathTree(localBranches, (b) => b.name, '/'),
    [localBranches]
  );
  const tagTree = useMemo(
    () => buildPathTree(tags ?? [], (tag) => tag.name, '-'),
    [tags]
  );

  const fleetByBranch = useMemo(() => {
    const map = new Map<string, FleetBranch>();
    for (const fb of fleetBranches) map.set(fb.workspace.branch, fb);
    return map;
  }, [fleetBranches]);

  const renderBranchLeaf = (
    node: PathNode<GitBranch>,
    depth: number
  ): React.ReactNode => {
    const branch = node.value!;
    const fleet = fleetByBranch.get(branch.name);
    const isCurrent = branch.is_current;
    return (
      <button
        key={`leaf-${node.path}`}
        type="button"
        onClick={
          fleet ? () => onSelectWorkspace(fleet.workspace.id) : undefined
        }
        style={{ paddingLeft: 16 + depth * 14 }}
        className={cn(
          'flex h-[22px] w-full items-center gap-2 pr-2 text-left text-sm',
          fleet
            ? 'cursor-pointer hover:bg-secondary'
            : 'cursor-default hover:bg-secondary/50'
        )}
      >
        <span
          className={cn(
            'h-[6px] w-[6px] flex-none rounded-full',
            fleet
              ? fleet.attentionReason === 'conflict'
                ? 'bg-error'
                : FLEET_DOT[fleet.group]
              : isCurrent
                ? 'bg-brand-on-surface'
                : 'bg-transparent'
          )}
          aria-hidden
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-code',
            isCurrent ? 'text-high font-semibold' : 'text-normal'
          )}
        >
          {node.name}
        </span>
      </button>
    );
  };

  const renderTagLeaf = (
    node: PathNode<{ name: string; target_oid: string }>,
    depth: number
  ): React.ReactNode => (
    <div
      key={`leaf-${node.path}`}
      style={{ paddingLeft: 16 + depth * 14 }}
      className="flex h-[22px] items-center gap-2 pr-2 text-sm text-normal hover:bg-secondary/50"
    >
      <Tag className="h-3 w-3 flex-none text-low" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate font-mono text-code">
        {node.name}
      </span>
    </div>
  );

  // A node that is both an item and a folder renders the folder row and,
  // when open, itself as the first leaf inside.
  const renderTree = <T,>(
    node: PathNode<T>,
    depth: number,
    state: ReturnType<typeof useExpandedSet>,
    renderLeaf: (node: PathNode<T>, depth: number) => React.ReactNode
  ): React.ReactNode => {
    if (node.children.length === 0) return renderLeaf(node, depth);
    const isOpen = state.expanded.has(node.path);
    return (
      <div key={`folder-${node.path}`}>
        <FolderRow
          name={node.name}
          count={countLeaves(node)}
          depth={depth}
          isOpen={isOpen}
          onToggle={() => state.toggle(node.path)}
        />
        {isOpen && (
          <>
            {node.value !== undefined && renderLeaf(node, depth + 1)}
            {node.children.map((child) =>
              renderTree(child, depth + 1, state, renderLeaf)
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <SidebarSection
        persistKey="source-control-branches"
        title={t('sourceControl.branchesTitle', { defaultValue: 'Branches' })}
        count={localBranches.length}
      >
        {branchTree.map((node) =>
          renderTree(node, 0, branchesExpanded, renderBranchLeaf)
        )}
      </SidebarSection>
      {(tags?.length ?? 0) > 0 && (
        <SidebarSection
          persistKey="source-control-tags"
          title={t('sourceControl.tagsTitle', { defaultValue: 'Tags' })}
          count={tags!.length}
          defaultOpen={false}
        >
          {tagTree.map((node) =>
            renderTree(node, 0, tagsExpanded, renderTagLeaf)
          )}
        </SidebarSection>
      )}
    </>
  );
}
