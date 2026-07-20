import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

interface SprintColumnProps {
  title: string;
  count: number | null;
  children: ReactNode;
  className?: string;
}

export function SprintColumn({
  title,
  count,
  children,
  className,
}: SprintColumnProps) {
  return (
    <section
      className={cn(
        'flex flex-col min-w-0 flex-1 bg-md-surface-container-low border border-md-outline-variant rounded-lg overflow-hidden',
        className
      )}
    >
      <header className="flex items-center gap-2 px-4 py-3 shrink-0 border-b border-md-outline-variant bg-md-surface-container">
        <h3 className="text-label-caps font-geist font-semibold text-md-on-surface-variant uppercase tracking-widest">
          {title}
        </h3>
        {count !== null && (
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-md-primary text-md-on-primary text-label-caps font-geist font-semibold tabular-nums">
            {count}
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 pt-2 flex flex-col gap-2.5">
        {children}
      </div>
    </section>
  );
}
