import { cn } from '@/shared/lib/utils';

interface EpicChipProps {
  milestone: string;
  className?: string;
}

export function EpicChip({ milestone, className }: EpicChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded-md border border-brand/25',
        'bg-brand/8 text-brand text-xs font-medium whitespace-nowrap',
        className
      )}
      title={milestone}
    >
      <span aria-hidden="true" className="text-[10px] leading-none">
        ◎
      </span>
      <span className="truncate max-w-[8rem]">{milestone}</span>
    </span>
  );
}
