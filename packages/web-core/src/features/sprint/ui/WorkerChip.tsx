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
        'inline-flex items-center gap-half h-5 px-base rounded-sm',
        'bg-panel text-normal text-xs font-medium whitespace-nowrap',
        className
      )}
      title={worker.name}
    >
      <span aria-hidden="true">{worker.emoji}</span>
      <span className="truncate max-w-[10rem]">{worker.name}</span>
    </span>
  );
}
