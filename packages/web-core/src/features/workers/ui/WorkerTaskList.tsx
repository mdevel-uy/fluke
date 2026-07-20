import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
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

  const queued = (tasks ?? []).filter(
    (task) => task.workspace_id !== activeWorkspaceId
  );

  if (queued.length === 0) {
    return (
      <div className="text-body-sm text-md-on-surface-variant py-1 italic">
        {t('workers.card.queueEmpty')}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-1.5">
      {queued.map((task) => (
        <li
          key={task.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-md-surface-container transition-colors"
        >
          <span className="w-6 shrink-0 text-md-on-surface-variant tabular-nums text-body-sm font-medium">
            {task.position}.
          </span>
          <span className="min-w-0 truncate text-body-sm text-md-on-surface">
            {task.title}
          </span>
          <span className="ml-auto shrink-0 inline-flex items-center h-4 px-1.5 rounded-full bg-md-surface-container text-md-on-surface-variant uppercase tracking-widest text-[10px] font-geist font-semibold border border-md-outline-variant">
            {task.status}
          </span>
        </li>
      ))}
    </ol>
  );
}
