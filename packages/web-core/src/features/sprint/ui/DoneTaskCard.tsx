import type { WorkerTask } from '@/features/sprint/types';

interface DoneTaskCardProps {
  task: WorkerTask;
}

export function DoneTaskCard({ task }: DoneTaskCardProps) {
  return (
    <article className="flex flex-col p-base bg-primary border border-border rounded-sm">
      <p
        className="text-sm text-low font-medium truncate line-through"
        title={task.title}
      >
        {task.title}
      </p>
    </article>
  );
}
