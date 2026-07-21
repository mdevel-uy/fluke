import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Workbench status bar (VSCode-style): 22px strip pinned to the bottom of
 * the app shell. Compose with StatusBarItem / StatusBarSpacer.
 */
export function StatusBar({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        'flex h-[22px] items-stretch overflow-hidden select-none',
        'bg-md-surface-container-lowest border-t border-md-outline-variant',
        'text-xs text-md-on-surface-variant',
        className
      )}
    >
      {children}
    </footer>
  );
}

export interface StatusBarItemProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'brand' | 'error' | 'warning';
  /** Render as a non-interactive span (no hover state) */
  readOnly?: boolean;
}

export function StatusBarItem({
  variant = 'default',
  readOnly = false,
  className,
  children,
  ...props
}: StatusBarItemProps) {
  const classes = cn(
    'flex items-center gap-1 px-2 whitespace-nowrap text-xs',
    variant === 'default' && !readOnly && 'hover:bg-secondary',
    variant === 'brand' &&
      'bg-brand text-on-brand font-semibold hover:bg-brand-hover',
    variant === 'error' && cn('text-error', !readOnly && 'hover:bg-secondary'),
    variant === 'warning' &&
      cn('text-warning', !readOnly && 'hover:bg-secondary'),
    readOnly && 'cursor-default',
    className
  );

  if (readOnly) {
    return <span className={classes}>{children}</span>;
  }
  return (
    <button type="button" className={classes} {...props}>
      {children}
    </button>
  );
}

export function StatusBarSpacer() {
  return <span className="flex-1" aria-hidden="true" />;
}
