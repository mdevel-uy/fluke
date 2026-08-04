import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
import type { IssueLabel } from '@/features/issues/types';

interface IssueLabelChipProps {
  label: IssueLabel;
  className?: string;
  onRemove?: () => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return [r, g, b];
}

function needsDarkText(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72;
}

function darkenHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const darken = (v: number) => Math.max(0, Math.round(v * (1 - amount)));
  return [darken(r), darken(g), darken(b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

export function IssueLabelChip({
  label,
  className,
  onRemove,
}: IssueLabelChipProps) {
  const hex = label.color.replace('#', '');
  const isValidHex = /^[0-9a-fA-F]{6}$/.test(hex);

  const removeButton = onRemove ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      className="opacity-0 group-hover/chip:opacity-100 transition-opacity rounded-full hover:text-md-error focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-md-primary"
      aria-label={`Remove label ${label.name}`}
    >
      <MaterialIcon name="close" size="sm" />
    </button>
  ) : null;

  if (!isValidHex) {
    return (
      <span
        className={cn(
          'group/chip inline-flex items-center gap-1 h-[18px] px-2 rounded-full',
          'bg-md-secondary-container text-md-on-secondary-container',
          'text-label-caps font-geist uppercase tracking-widest',
          'border border-md-outline-variant whitespace-nowrap',
          className
        )}
      >
        {label.name}
        {removeButton}
      </span>
    );
  }

  const [r, g, b] = hexToRgb(hex);
  const dark = needsDarkText(hex);

  const style: React.CSSProperties = {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.18)`,
    color: dark ? `#${darkenHex(hex, 0.45)}` : `#${hex}`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.35)`,
  };

  return (
    <span
      className={cn(
        'group/chip inline-flex items-center gap-1 h-[18px] px-2 rounded-full',
        'text-label-caps font-geist uppercase tracking-widest',
        'border whitespace-nowrap',
        className
      )}
      style={style}
      title={label.name}
    >
      {label.name}
      {removeButton}
    </span>
  );
}
