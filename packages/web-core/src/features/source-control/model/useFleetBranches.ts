import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { RepoBranchStatus } from 'shared/types';

// SHELL-SPEC R35: attempt branches grouped by fleet state. `merged` renders
// collapsed; `idle` is the catch-all for finished-but-unmerged work.
export type FleetGroup = 'attention' | 'running' | 'idle' | 'merged';

export type AttentionReason =
  | 'conflict'
  | 'approval'
  | 'stalled'
  | 'review'
  | 'activity';

export interface FleetBranch {
  workspace: SidebarWorkspace;
  group: FleetGroup;
  /** Per-repo git status rows — undefined until the first poll lands. */
  status: RepoBranchStatus[] | undefined;
  /** Status row for the shell's selected repo, else the first repo. */
  primaryStatus: RepoBranchStatus | undefined;
  hasConflicts: boolean;
  attentionReason: AttentionReason | null;
}

export interface FleetBranchesResult {
  branches: FleetBranch[];
  groups: Record<FleetGroup, FleetBranch[]>;
  /** Nº of branches with a stopped rebase/merge — rail badge (R34). */
  conflictCount: number;
  /** Base branch of the fleet (target of the selected repo), if known. */
  baseBranch: string | null;
  isLoading: boolean;
}

function classify(
  ws: SidebarWorkspace,
  hasConflicts: boolean
): { group: FleetGroup; attentionReason: AttentionReason | null } {
  if (ws.prStatus === 'merged') return { group: 'merged', attentionReason: null };
  if (hasConflicts) return { group: 'attention', attentionReason: 'conflict' };
  if (ws.hasPendingApproval)
    return { group: 'attention', attentionReason: 'approval' };
  if (ws.hasStalledTask)
    return { group: 'attention', attentionReason: 'stalled' };
  if (ws.prStatus === 'open' && !ws.isRunning)
    return { group: 'attention', attentionReason: 'review' };
  if (ws.hasUnseenActivity && !ws.isRunning)
    return { group: 'attention', attentionReason: 'activity' };
  if (ws.isRunning) return { group: 'running', attentionReason: null };
  return { group: 'idle', attentionReason: null };
}

/**
 * Fleet-wide git view (SHELL-SPEC R34-R36): every active workspace branch
 * with its per-repo git status. Reuses the ['branchStatus', id] cache the
 * workspace aside polls, so visiting Source control adds no duplicate
 * requests for the workspace you were just looking at.
 */
export function useFleetBranches(
  selectedRepoId: string | null
): FleetBranchesResult {
  const { activeWorkspaces, isWorkspacesListLoading } = useWorkspaceContext();

  const statusResults = useQueries({
    queries: activeWorkspaces.map((ws) => ({
      queryKey: ['branchStatus', ws.id],
      queryFn: () => workspacesApi.getBranchStatus(ws.id),
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });

  return useMemo(() => {
    const branches: FleetBranch[] = activeWorkspaces.map((ws, i) => {
      const status = statusResults[i]?.data as RepoBranchStatus[] | undefined;
      const primaryStatus =
        status?.find((r) => r.repo_id === selectedRepoId) ?? status?.[0];
      const hasConflicts = (status ?? []).some(
        (r) => r.conflicted_files.length > 0 || r.is_rebase_in_progress
      );
      const { group, attentionReason } = classify(ws, hasConflicts);
      return {
        workspace: ws,
        group,
        status,
        primaryStatus,
        hasConflicts,
        attentionReason,
      };
    });

    const groups: Record<FleetGroup, FleetBranch[]> = {
      attention: [],
      running: [],
      idle: [],
      merged: [],
    };
    for (const branch of branches) groups[branch.group].push(branch);

    return {
      branches,
      groups,
      conflictCount: branches.filter((b) => b.hasConflicts).length,
      baseBranch:
        branches.find((b) => b.primaryStatus)?.primaryStatus
          ?.target_branch_name ?? null,
      isLoading: isWorkspacesListLoading,
    };
  }, [activeWorkspaces, statusResults, selectedRepoId, isWorkspacesListLoading]);
}
