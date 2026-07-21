import { SpinnerIcon } from '@phosphor-icons/react';
import type { ComponentType } from 'react';
import { cn } from '../lib/cn';

// Accepts either a Phosphor icon or a Lucide icon component. Both are
// component types that take a className; Phosphor also accepts weight.
type IconLike = ComponentType<Record<string, unknown>>;

interface PrimaryButtonProps {
  variant?: 'default' | 'secondary' | 'tertiary';
  actionIcon?: IconLike | 'spinner';
  value?: string;
  onClick?: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function PrimaryButton({
  variant = 'default',
  actionIcon: ActionIcon,
  value,
  onClick,
  disabled,
  children,
  className,
}: PrimaryButtonProps) {
  const variantStyles = disabled
    ? 'cursor-not-allowed bg-secondary text-low border border-border/60'
    : variant === 'default'
      ? 'bg-brand hover:bg-brand-hover text-on-brand shadow-soft'
      : variant === 'secondary'
        ? 'bg-brand/10 text-brand-on-surface hover:bg-brand/15 dark:bg-brand/15 dark:hover:bg-brand/25'
        : 'bg-secondary hover:bg-panel text-normal border border-border/60 hover:text-high';

  return (
    <button
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-3 h-8 text-sm font-medium',
        'transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'active:scale-[0.98]',
        variantStyles,
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {value}
      {children}
      {ActionIcon ? (
        ActionIcon === 'spinner' ? (
          <SpinnerIcon className={'size-icon-sm animate-spin'} weight="bold" />
        ) : (
          <ActionIcon className={'h-3.5 w-3.5'} weight="bold" />
        )
      ) : null}
    </button>
  );
}
