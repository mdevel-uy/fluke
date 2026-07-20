import { X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface IssueLabelChipProps {
  label: string;
  color?: string;
  className?: string;
  onRemove?: () => void;
}

export function IssueLabelChip({
  label,
  color,
  className,
  onRemove,
}: IssueLabelChipProps) {
  const style = color
    ? {
        backgroundColor: `#${color}1a`,
        borderColor: `#${color}66`,
        color: `#${color}`,
      }
    : undefined;

  return (
    <span
      className={cn(
        'group/chip inline-flex items-center gap-1 h-5 px-2 rounded-full',
        'bg-secondary text-low text-xs font-medium whitespace-nowrap border border-border/50',
        className
      )}
      style={style}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-0 group-hover/chip:opacity-100 transition-opacity -mr-0.5 rounded-full hover:text-error focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Remove label ${label}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
