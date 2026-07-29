import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Tag } from 'lucide-react';
import type { GitBranch } from 'shared/types';
import { repoApi } from '@/shared/lib/api';
import { SidebarSection } from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

interface BranchNode {
  /** Last path segment, shown as the row label. */
  name: string;
  /** Full ref path up to this node — folder key / branch name. */
  path: string;
  children: BranchNode[];
  /** Present on leaves only. */
  branch?: GitBranch;
}

// Git refuses refs where a name is both a file and a directory, so one
// child per segment name is safe.
function buildBranchTree(branches: GitBranch[]): BranchNode[] {
  const root: BranchNode = { name: '', path: '', children: [] };
  for (const branch of branches) {
    const parts = branch.name.split('/');
    let node = root;
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path, children: [] };
        node.children.push(child);
      }
      if (index === parts.length - 1) child.branch = branch;
      node = child;
    });
  }
  const sortChildren = (node: BranchNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root.children;
}

const FLEET_DOT: Record<FleetBranch['group'], string> = {
  attention: 'bg-warning',
  running: 'bg-brand-on-surface animate-pulse',
  idle: 'bg-border-strong',
  merged: 'bg-merged',
};

interface SourceControlBranchesSectionsProps {
  repoId: string | null;
  fleetBranches: FleetBranch[];
  onSelectWorkspace: (workspaceId: string) => void;
}

/**
 * Sourcetree-style Branches (slash-nested tree) and Tags sections for the
 * Source control sidebar. Branch leaves that back an active workspace show
 * their fleet dot and select that workspace on click.
 */
export function SourceControlBranchesSections({
  repoId,
  fleetBranches,
  onSelectWorkspace,
}: SourceControlBranchesSectionsProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
  const tree = useMemo(() => buildBranchTree(localBranches), [localBranches]);

  const fleetByBranch = useMemo(() => {
    const map = new Map<string, FleetBranch>();
    for (const fb of fleetBranches) map.set(fb.workspace.branch, fb);
    return map;
  }, [fleetBranches]);

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: BranchNode, depth: number): React.ReactNode => {
    const indent = { paddingLeft: 16 + depth * 14 };
    if (!node.branch) {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => toggleFolder(node.path)}
            style={indent}
            className="flex h-[22px] w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-sm text-normal hover:bg-secondary"
          >
            {isOpen ? (
              <ChevronDown className="h-3 w-3 flex-none text-low" />
            ) : (
              <ChevronRight className="h-3 w-3 flex-none text-low" />
            )}
            <span className="min-w-0 truncate">{node.name}</span>
            <span className="flex-none text-[11px] text-low">
              {countLeaves(node)}
            </span>
          </button>
          {isOpen && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const fleet = fleetByBranch.get(node.branch.name);
    const isCurrent = node.branch.is_current;
    return (
      <button
        key={node.path}
        type="button"
        onClick={
          fleet ? () => onSelectWorkspace(fleet.workspace.id) : undefined
        }
        style={indent}
        className={cn(
          'flex h-[22px] w-full items-center gap-2 pr-2 text-left text-sm',
          fleet ? 'cursor-pointer hover:bg-secondary' : 'cursor-default',
          !fleet && 'hover:bg-secondary/50'
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

  return (
    <>
      <SidebarSection
        persistKey="source-control-branches"
        title={t('sourceControl.branchesTitle', { defaultValue: 'Branches' })}
        count={localBranches.length}
      >
        {tree.map((node) => renderNode(node, 0))}
      </SidebarSection>
      {(tags?.length ?? 0) > 0 && (
        <SidebarSection
          persistKey="source-control-tags"
          title={t('sourceControl.tagsTitle', { defaultValue: 'Tags' })}
          count={tags!.length}
          defaultOpen={false}
        >
          {tags!.map((tag) => (
            <div
              key={tag.name}
              className="flex h-[22px] items-center gap-2 pl-4 pr-2 text-sm text-normal"
            >
              <Tag className="h-3 w-3 flex-none text-low" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate font-mono text-code">
                {tag.name}
              </span>
            </div>
          ))}
        </SidebarSection>
      )}
    </>
  );
}

function countLeaves(node: BranchNode): number {
  if (node.branch && node.children.length === 0) return 1;
  let total = node.branch ? 1 : 0;
  for (const child of node.children) total += countLeaves(child);
  return total;
}
