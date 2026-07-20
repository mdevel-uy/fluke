import { cn } from '@/shared/lib/utils';

interface IssueLabelChipProps {
  label: string;
  className?: string;
}

export function IssueLabelChip({ label, className }: IssueLabelChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-[18px] px-2 rounded-full',
        'bg-md-secondary-container text-md-on-secondary-container',
        'text-label-caps font-geist font-semibold uppercase tracking-widest',
        'border border-md-outline-variant whitespace-nowrap',
        className
      )}
    >
      {label}
    </span>
  );
}
