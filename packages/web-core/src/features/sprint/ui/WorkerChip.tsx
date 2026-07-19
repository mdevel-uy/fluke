import { cn } from '@/shared/lib/utils';
import type { Worker } from '@/features/sprint/types';

interface WorkerChipProps {
  worker: Pick<Worker, 'name' | 'emoji'>;
  className?: string;
}

export function WorkerChip({ worker, className }: WorkerChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-6 px-2 rounded-full',
        'bg-secondary text-normal text-xs font-medium whitespace-nowrap border border-border/60',
        className
      )}
      title={worker.name}
    >
      <span className="text-sm leading-none" aria-hidden="true">
        {worker.emoji}
      </span>
      <span className="truncate max-w-[10rem]">{worker.name}</span>
    </span>
  );
}
