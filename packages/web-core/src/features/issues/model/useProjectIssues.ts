import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectIssuesApi } from '@/shared/lib/api';
import type { ProjectIssue } from '@/features/issues/types';
import { projectIssuesKeys } from './projectIssuesKeys';

export function useProjectIssues(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId
      ? projectIssuesKeys.byProject(projectId)
      : projectIssuesKeys.all,
    queryFn: () => projectIssuesApi.list(projectId!),
    enabled: !!projectId,
  });
}

export function useSyncProjectIssues(projectId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<ProjectIssue[]> => {
      if (!projectId) {
        throw new Error('projectId is required to sync issues');
      }
      return projectIssuesApi.sync(projectId);
    },
    onSuccess: (data) => {
      if (!projectId) return;
      queryClient.setQueryData(projectIssuesKeys.byProject(projectId), data);
    },
  });
}
