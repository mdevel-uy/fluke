import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers/model/workersKeys';
import type { Worker, WorkerTask } from '@/features/sprint/types';

export function useWorkers() {
  return useQuery({
    queryKey: workersKeys.list(),
    queryFn: () => workersApi.list() as Promise<Worker[]>,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export interface AllWorkerTasksResult {
  tasks: WorkerTask[];
  isLoading: boolean;
  isError: boolean;
}

export function useAllWorkerTasks(
  workers: Worker[] | undefined
): AllWorkerTasksResult {
  const results = useQueries({
    queries: (workers ?? []).map((worker) => ({
      queryKey: workersKeys.tasks(worker.id),
      queryFn: () => workersApi.listTasks(worker.id) as Promise<WorkerTask[]>,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    })),
  });

  return useMemo(() => {
    const tasks: WorkerTask[] = [];
    let isLoading = false;
    let isError = false;
    for (const r of results) {
      if (r.isLoading) isLoading = true;
      if (r.isError) isError = true;
      if (r.data) tasks.push(...r.data);
    }
    return { tasks, isLoading, isError };
  }, [results]);
}
