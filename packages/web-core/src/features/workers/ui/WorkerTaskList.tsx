import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers';
import { repoIssuesKeys } from '@/features/issues/model/repoIssuesKeys';
import { useWorkerTasks } from '@/features/workers/model/useWorkers';
import type { WorkerTaskResponse } from 'shared/types';

interface WorkerTaskListProps {
  workerId: string;
  activeWorkspaceId: string | null;
}

export function WorkerTaskList({
  workerId,
  activeWorkspaceId,
}: WorkerTaskListProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { data: tasks, isLoading, isError } = useWorkerTasks(workerId, true);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: workersKeys.all });

  const retryMutation = useMutation({
    mutationFn: async (task: WorkerTaskResponse) => {
      const queued = (tasks ?? []).filter((t) => t.status === 'queued');
      const minPosition =
        queued.length > 0 ? Math.min(...queued.map((t) => t.position)) : 0;
      await workersApi.updateTask(task.worker_id, task.id, {
        status: 'queued',
        position: minPosition - 1,
      });
    },
    onSuccess: () => {
      invalidate();
      // The server auto-starts the retried task moments after the PATCH;
      // refresh again shortly so the card reflects in_progress without
      // waiting for the 30s poll.
      setTimeout(invalidate, 2500);
    },
  });

  const discardMutation = useMutation({
    mutationFn: async (task: WorkerTaskResponse) => {
      await workersApi.deleteTask(task.worker_id, task.id);
    },
    onSuccess: (_data, task) => {
      invalidate();
      queryClient.invalidateQueries({
        queryKey: repoIssuesKeys.byRepo(task.repo_id),
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-md-on-surface-variant text-body-sm py-1">
        <MaterialIcon
          name="progress_activity"
          size="sm"
          className="animate-spin text-md-primary"
        />
        <span>{t('workers.card.queueLoading')}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-body-sm text-md-error py-1">
        {t('workers.card.queueError')}
      </div>
    );
  }

  const visible = (tasks ?? []).filter(
    (task) => task.workspace_id !== activeWorkspaceId && task.status !== 'done'
  );

  if (visible.length === 0) {
    return (
      <div className="text-body-sm text-md-on-surface-variant py-1 italic">
        {t('workers.card.queueEmpty')}
      </div>
    );
  }

  const isBusy = retryMutation.isPending || discardMutation.isPending;

  return (
    <ol className="flex flex-col gap-1.5">
      {visible.map((task) => {
        const isFailed = task.status === 'failed';
        return (
          <li
            key={task.id}
            className={
              'flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ' +
              (isFailed
                ? 'bg-md-error/5 border border-md-error/20 hover:bg-md-error/10'
                : 'hover:bg-md-surface-container')
            }
          >
            <span className="w-6 shrink-0 text-md-on-surface-variant tabular-nums text-body-sm font-medium">
              {task.position}.
            </span>
            <span className="min-w-0 truncate text-body-sm text-md-on-surface flex-1">
              {task.title}
            </span>
            {isFailed ? (
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  variant="icon"
                  size="icon"
                  onClick={() => retryMutation.mutate(task)}
                  disabled={isBusy}
                  aria-label={t('sprint.failed.retry')}
                  title={t('sprint.failed.retry')}
                  className="h-5 w-5 hover:text-md-primary"
                >
                  <MaterialIcon name="refresh" size="xs" />
                </Button>
                <Button
                  variant="icon"
                  size="icon"
                  onClick={() => discardMutation.mutate(task)}
                  disabled={isBusy}
                  aria-label={t('sprint.failed.discard')}
                  title={t('sprint.failed.discard')}
                  className="h-5 w-5 hover:text-md-error"
                >
                  <MaterialIcon name="delete" size="xs" />
                </Button>
              </div>
            ) : (
              <span className="ml-auto shrink-0 inline-flex items-center h-4 px-1.5 rounded-full bg-md-surface-container text-md-on-surface-variant uppercase tracking-widest text-[10px] font-geist font-semibold border border-md-outline-variant">
                {task.status}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
