import { cn } from '@/shared/lib/utils';
import type { IssueLabel } from '@/features/issues/types';

interface IssueLabelChipProps {
  label: IssueLabel;
  className?: string;
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

export function IssueLabelChip({ label, className }: IssueLabelChipProps) {
  const hex = label.color.replace('#', '');
  const isValidHex = /^[0-9a-fA-F]{6}$/.test(hex);

  if (!isValidHex) {
    return (
      <span
        className={cn(
          'inline-flex items-center h-5 px-2 rounded-full',
          'bg-secondary text-low text-xs font-medium whitespace-nowrap border border-border/50',
          className
        )}
      >
        {label.name}
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
        'inline-flex items-center h-5 px-2 rounded-full',
        'text-xs font-medium whitespace-nowrap border',
        className
      )}
      style={style}
      title={label.name}
    >
      {label.name}
    </span>
  );
}
