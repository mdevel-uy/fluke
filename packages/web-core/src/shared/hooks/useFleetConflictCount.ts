import { useQueries } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';

/**
 * Nº of active workspaces stopped on git conflicts — feeds the Source
 * control rail badge (SHELL-SPEC R34). Shares the ['branchStatus', id]
 * cache with the workspace aside and the fleet view; the slow interval
 * only applies when no other observer polls faster.
 */
export function useFleetConflictCount(): number {
  const { activeWorkspaces } = useWorkspaceContext();

  const results = useQueries({
    queries: activeWorkspaces.map((ws) => ({
      queryKey: ['branchStatus', ws.id],
      queryFn: () => workspacesApi.getBranchStatus(ws.id),
      refetchInterval: 30_000,
      staleTime: 20_000,
    })),
  });

  return results.filter((result) =>
    (result.data ?? []).some(
      (repo) => repo.conflicted_files.length > 0 || repo.is_rebase_in_progress
    )
  ).length;
}
