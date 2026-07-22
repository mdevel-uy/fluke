import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

/* Workbench board primitives — 1:1 port of the mockup's board:
   transparent columns with hairline separators, caps header + outlined
   count pill; flat task cards with the running-accent stripe. */

export function Board({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 gap-5 overflow-x-auto bg-md-background px-4 py-3',
        className
      )}
    >
      {children}
    </div>
  );
}

export function BoardColumn({
  title,
  count,
  className,
  children,
}: {
  title: string;
  count?: number | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-1 flex-col',
        'border-l border-md-outline-variant pl-5 first:border-l-0 first:pl-0',
        className
      )}
    >
      <header className="mb-2 flex h-6 flex-none items-center gap-2">
        <h3 className="text-label font-semibold uppercase tracking-wider text-md-on-surface-variant">
          {title}
        </h3>
        {count !== undefined && count !== null && (
          <span className="inline-flex h-[15px] min-w-[18px] items-center justify-center rounded-full border border-md-outline px-1.5 text-label leading-none text-md-on-surface-variant tabular-nums">
            {count}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

interface TaskCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Running task: 2px accent stripe + semibold title (the board's only
      persistent accent, per the design contract) */
  running?: boolean;
  selected?: boolean;
}

export function TaskCard({
  running = false,
  selected = false,
  className,
  children,
  ...props
}: TaskCardProps) {
  return (
    <div
      className={cn(
        'cursor-pointer rounded-lg border border-md-outline-variant bg-card px-2.5 py-2 transition-colors duration-150',
        'hover:border-border-strong hover:bg-secondary/40',
        running && 'border-l-2 border-l-brand-on-surface pl-[9px]',
        selected && 'bg-sel/50 ring-1 ring-brand-on-surface',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function TaskTitle({
  running = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { running?: boolean }) {
  return (
    <p
      className={cn(
        'mb-1.5 text-sm leading-snug text-high',
        running && 'font-semibold',
        className
      )}
      {...props}
    >
      {children}
    </p>
  );
}

export function TaskMeta({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-label normal-case tracking-normal text-low',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MetaPillTone = 'ok' | 'warn' | 'err' | 'mod' | 'info' | 'neutral';

const PILL_TONES: Record<MetaPillTone, string> = {
  ok: 'text-success bg-success/10',
  warn: 'text-warning bg-warning/10',
  err: 'text-error bg-destructive/10',
  mod: 'text-mod bg-mod/10',
  info: 'text-info bg-info/10',
  neutral: 'text-normal bg-secondary',
};

export function MetaPill({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: MetaPillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1 rounded-full px-2 text-label normal-case tracking-normal',
        PILL_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Mono({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>;
}
