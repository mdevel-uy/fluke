import { Check } from 'lucide-react';
import type { WorkerTask } from '@/features/sprint/types';

interface DoneTaskCardProps {
  task: WorkerTask;
}

export function DoneTaskCard({ task }: DoneTaskCardProps) {
  return (
    <article className="flex items-start gap-2 p-3.5 bg-primary/60 border border-border/50 rounded-xl">
      <span
        className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success shrink-0"
        aria-hidden
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <p
        className="text-sm text-low font-medium leading-snug line-clamp-2"
        title={task.title}
      >
        {task.title}
      </p>
    </article>
  );
}
