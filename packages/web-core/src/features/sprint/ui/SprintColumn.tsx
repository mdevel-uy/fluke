import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

export function SprintColumn({
  title,
  count,
  children,
  className,
  headerAction,
}: {
  title: string;
  count: number | null;
  children: ReactNode;
  className?: string;
  headerAction?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex flex-col min-w-0 flex-1',
        'border-l border-md-outline-variant pl-4 first:border-l-0 first:pl-0',
        className
      )}
    >
      <header className="flex items-center gap-2 h-6 mb-2 shrink-0">
        <h3 className="text-label font-semibold text-md-on-surface-variant uppercase tracking-wider">
          {title}
        </h3>
        {count !== null && (
          <span className="inline-flex items-center justify-center min-w-[1.125rem] h-[15px] px-1.5 rounded-full border border-md-outline text-md-on-surface-variant text-label tabular-nums leading-none">
            {count}
          </span>
        )}
        {headerAction}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
        {children}
      </div>
    </section>
  );
}
