import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';

/**
 * Conflict-resolution actions for a workspace repo (SHELL-SPEC R39 / V6).
 * Backend routes: POST /git/rebase/continue and /git/conflicts/abort.
 */
export function useWorkspaceConflicts(workspaceId?: string) {
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['branchStatus', workspaceId] });

  const continueMutation = useMutation({
    mutationFn: async (repoId: string) => {
      if (!workspaceId) return;
      await workspacesApi.continueRebase(workspaceId, { repo_id: repoId });
    },
    onSettled: invalidate,
  });

  const abortMutation = useMutation({
    mutationFn: async (repoId: string) => {
      if (!workspaceId) return;
      await workspacesApi.abortConflicts(workspaceId, { repo_id: repoId });
    },
    onSettled: invalidate,
  });

  return {
    continueRebase: continueMutation.mutateAsync,
    isContinuing: continueMutation.isPending,
    continueError: continueMutation.error,
    abortConflicts: abortMutation.mutateAsync,
    isAborting: abortMutation.isPending,
    abortError: abortMutation.error,
  } as const;
}
