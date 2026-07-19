import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
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

  const queued = (tasks ?? []).filter(
    (task) => task.workspace_id !== activeWorkspaceId
  );

  if (queued.length === 0) {
    return (
      <div className="text-xs text-low py-1 italic">
        {t('workers.card.queueEmpty')}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-1.5">
      {queued.map((task) => (
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
  );
}
