import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useWorkerTasks } from '@/features/workers/model/useWorkers';

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

  if (isLoading) {
    return (
      <div className="flex items-center gap-half text-low text-xs py-half">
        <SpinnerIcon className="size-icon-sm animate-spin" />
        <span>{t('workers.card.queueLoading')}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-xs text-error py-half">
        {t('workers.card.queueError')}
      </div>
    );
  }

  const queued = (tasks ?? []).filter(
    (task) => task.workspace_id !== activeWorkspaceId
  );

  if (queued.length === 0) {
    return (
      <div className="text-xs text-low py-half">
        {t('workers.card.queueEmpty')}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-1">
      {queued.map((task) => (
        <li
          key={task.id}
          className="flex items-baseline gap-2 text-xs text-normal"
        >
          <span className="w-6 shrink-0 text-low tabular-nums">
            {task.position}.
          </span>
          <span className="min-w-0 truncate">{task.title}</span>
          <span className="ml-auto shrink-0 text-low uppercase tracking-wide text-[10px]">
            {task.status}
          </span>
        </li>
      ))}
    </ol>
  );
}
