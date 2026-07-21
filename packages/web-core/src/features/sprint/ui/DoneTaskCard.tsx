import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import type { WorkerTask } from '@/features/sprint/types';

interface DoneTaskCardProps {
  task: WorkerTask;
}

export function DoneTaskCard({ task }: DoneTaskCardProps) {
  return (
    <article className="flex items-start gap-2 p-3.5 bg-md-surface-container-lowest/60 border border-md-outline-variant/50 rounded-lg">
      <span
        className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success shrink-0"
        aria-hidden
      >
        <MaterialIcon name="check" size="xs" />
      </span>
      <p
        className="text-body-sm font-sans text-md-on-surface-variant font-medium leading-snug line-clamp-2"
        title={task.title}
      >
        {task.title}
      </p>
    </article>
  );
}
