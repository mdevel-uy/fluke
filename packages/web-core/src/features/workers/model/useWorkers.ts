import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workersApi,
  type CreateWorkerRequest,
  type UpdateWorkerRequest,
} from '@/shared/lib/api';
import { workersKeys } from './workersKeys';

export function useWorkers() {
  return useQuery({
    queryKey: workersKeys.list(),
    queryFn: () => workersApi.list(),
  });
}

export function useWorkerTasks(workerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workerId ? workersKeys.tasks(workerId) : workersKeys.all,
    queryFn: () => workersApi.listTasks(workerId!),
    enabled: !!workerId && enabled,
  });
}

export function useCreateWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWorkerRequest) => workersApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.list() });
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
      queryClient.invalidateQueries({ queryKey: workersKeys.list() });
    },
  });
}

export function useDeleteWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.delete(workerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workersKeys.list() });
    },
  });
}

export function useStartNextWorkerTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) => workersApi.startNext(workerId),
    onSuccess: (_data, workerId) => {
      queryClient.invalidateQueries({ queryKey: workersKeys.list() });
      queryClient.invalidateQueries({
        queryKey: workersKeys.tasks(workerId),
      });
    },
  });
}
