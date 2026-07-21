import { cn } from '@/shared/lib/utils';
import type { Worker } from '@/features/sprint/types';

const ROLE_DOT_CLASS: Record<string, string> = {
  analyst: 'bg-brand',
  reviewer: 'bg-warning',
};

interface WorkerChipProps {
  worker: Pick<Worker, 'name' | 'emoji' | 'role'>;
  className?: string;
}

export function WorkerChip({ worker, className }: WorkerChipProps) {
  const dotClass = ROLE_DOT_CLASS[worker.role] ?? 'bg-muted-foreground/40';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-6 px-2 rounded-full',
        'bg-secondary text-normal text-xs font-medium whitespace-nowrap border border-border/60',
        className
      )}
      title={worker.name}
    >
      <span
        className={cn('h-2 w-2 rounded-full shrink-0', dotClass)}
        aria-hidden
      />
      <span className="text-sm leading-none" aria-hidden="true">
        {worker.emoji}
      </span>
      <span className="truncate max-w-[10rem]">{worker.name}</span>
    </span>
  );
}
