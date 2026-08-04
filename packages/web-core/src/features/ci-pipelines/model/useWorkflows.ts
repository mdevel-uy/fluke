import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  listWorkflowFiles,
  loadWorkflow,
  type WorkflowFileEntry,
} from './workflowFiles';
import { usePipelineStore } from './usePipelineStore';

export const workflowFilesKey = (repoPath: string) =>
  ['ci-pipelines', 'workflows', repoPath] as const;

/** Workflow pairs (`.yml` + optional `.mkanban.json`) of a repo. */
export function useWorkflowFiles(repoPath: string | null) {
  const { data, isLoading } = useQuery({
    queryKey: workflowFilesKey(repoPath ?? ''),
    queryFn: () => listWorkflowFiles(repoPath ?? ''),
    enabled: repoPath !== null,
  });
  return { workflows: data ?? [], isLoadingWorkflows: isLoading };
}

/** Load a workflow pair from disk into the editing session store. */
export function useOpenWorkflow() {
  const open = usePipelineStore((s) => s.open);
  return useCallback(
    async (entry: WorkflowFileEntry) => {
      const loaded = await loadWorkflow(entry);
      open(loaded.entry, loaded.graph, {
        fromSidecar: loaded.fromSidecar,
        drifted: loaded.drifted,
      });
    },
    [open]
  );
}

export function useInvalidateWorkflows() {
  const queryClient = useQueryClient();
  return useCallback(
    (repoPath: string) =>
      queryClient.invalidateQueries({ queryKey: workflowFilesKey(repoPath) }),
    [queryClient]
  );
}
