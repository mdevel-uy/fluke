import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

/* Workbench card — the mockup's "wcard": a small flat panel with a
   bordered header row, key-value body rows and a tinted footer. */

export function WbCard({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-md-outline-variant bg-card',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function WbCardHeader({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-md-outline-variant py-1.5 pl-3 pr-2',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function WbCardTitle({ children }: { children: ReactNode }) {
  return <b className="text-sm font-semibold text-high">{children}</b>;
}

export function WbCardSpacer() {
  return <span className="flex-1" aria-hidden />;
}

export function WbCardBody({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1.5 px-3 py-2.5', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** Key-value row: 13px muted icon + text */
export function WbKv({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-normal">
      {icon && (
        <span className="flex w-[13px] flex-none items-center justify-center text-low [&>svg]:h-[13px] [&>svg]:w-[13px]">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

export function WbCardFooter({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-t border-md-outline-variant bg-md-surface-container-lowest px-2 py-1.5',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
