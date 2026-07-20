import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import {
  useWorkerTasks,
  useRetryWorkerTask,
} from '@/features/workers/model/useWorkers';

interface WorkerTaskListProps {
  workerId: string;
  activeWorkspaceId: string | null;
}

export function WorkerTaskList({
  workerId,
  activeWorkspaceId,
}: WorkerTaskListProps) {
  const { t } = useTranslation('common');
  const { data: tasks, isLoading, isError } = useWorkerTasks(workerId, true);
  const retryMutation = useRetryWorkerTask();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-low text-xs py-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
        <span>{t('workers.card.queueLoading')}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-xs text-error py-1">
        {t('workers.card.queueError')}
      </div>
    );
  }

  const visible = (tasks ?? []).filter(
    (task) => task.workspace_id !== activeWorkspaceId
  );

  const failedTasks = visible.filter((task) => task.status === 'failed');
  const otherTasks = visible.filter((task) => task.status !== 'failed');

  if (visible.length === 0) {
    return (
      <div className="text-xs text-low py-1 italic">
        {t('workers.card.queueEmpty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {failedTasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3 w-3" />
            {t('workers.card.failedTasksHeader', { count: failedTasks.length })}
          </div>
          <ol className="flex flex-col gap-1">
            {failedTasks.map((task) => (
              <li
                key={task.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-warning/10 border border-warning/20"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-normal">
                  {task.title}
                </span>
                <span className="shrink-0 inline-flex items-center h-4 px-1.5 rounded-full bg-warning/20 text-warning uppercase tracking-wide text-[10px] font-medium">
                  {t('workers.card.taskFailedBadge')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-brand hover:text-brand-hover"
                  aria-label={t('workers.card.taskRetry')}
                  disabled={retryMutation.isPending}
                  onClick={() =>
                    retryMutation.mutate({ workerId, taskId: task.id })
                  }
                >
                  {retryMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {otherTasks.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {otherTasks.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary/60 transition-colors"
            >
              <span className="w-6 shrink-0 text-low tabular-nums text-xs font-medium">
                {task.position}.
              </span>
              <span className="min-w-0 truncate text-xs text-normal">
                {task.title}
              </span>
              <span className="ml-auto shrink-0 inline-flex items-center h-4 px-1.5 rounded-full bg-secondary text-low uppercase tracking-wide text-[10px] font-medium border border-border/50">
                {task.status}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
