import { cn } from '@/shared/lib/utils';

interface IssueLabelChipProps {
  label: string;
  className?: string;
}

// Replicates the format of features/issues/ui/IssueLabelChip verbatim —
// the original component is not part of the issues feature's public
// index.
export function IssueLabelChip({ label, className }: IssueLabelChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-2 rounded-full',
        'bg-secondary text-low text-xs font-medium whitespace-nowrap border border-border/50',
        className
      )}
    >
      {label}
    </span>
  );
}
