import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { workersApi } from '@/shared/lib/api';
import type { Worker, WorkerTask } from '@/features/sprint/types';
import { sprintKeys } from './sprintKeys';

export function useWorkers() {
  return useQuery({
    queryKey: sprintKeys.workers,
    queryFn: () => workersApi.list() as Promise<Worker[]>,
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
      queryKey: sprintKeys.tasksByWorker(worker.id),
      queryFn: () => workersApi.listTasks(worker.id) as Promise<WorkerTask[]>,
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
