import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  systemApi,
  workersApi,
  type CreateWorkerRequest,
  type UpdateWorkerRequest,
  type StartAllWorkersResponse,
} from '@/shared/lib/api';
import { workersKeys } from './workersKeys';

export function useBaseInstructions() {
  return useQuery({
    queryKey: ['system', 'base-instructions'],
    queryFn: () => systemApi.getBaseInstructions(),
    staleTime: Infinity,
  });
}

export function useWorkers() {
  return useQuery({
    queryKey: workersKeys.list(),
    queryFn: () => workersApi.list(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useWorkerTasks(workerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workerId ? workersKeys.tasks(workerId) : workersKeys.all,
    queryFn: () => workersApi.listTasks(workerId!),
    enabled: !!workerId && enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkerRequest) => workersApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useUpdateWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workerId,
      data,
    }: {
      workerId: string;
      data: UpdateWorkerRequest;
    }) => workersApi.update(workerId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useDeleteWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.delete(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useDeleteAllArchivedWorkers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => workersApi.deleteAllArchived(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useArchiveWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.archive(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useUnarchiveWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.unarchive(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useArchivedWorkers(enabled = true) {
  return useQuery({
    queryKey: workersKeys.archived(),
    queryFn: () => workersApi.listArchived(),
    enabled,
    // Archived workers rarely change; polling would waste requests, but a
    // manual refetch on focus keeps a second tab in sync after a restore
    // or purge.
    refetchOnWindowFocus: true,
  });
}

export function useDuplicateWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.duplicate(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useStartNextWorkerTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.startNext(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.all });
    },
  });
}

export function useStartAllWorkers() {
  const queryClient = useQueryClient();
  return useMutation<StartAllWorkersResponse>({
    mutationFn: () => workersApi.startAll(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.list() });
    },
  });
}
