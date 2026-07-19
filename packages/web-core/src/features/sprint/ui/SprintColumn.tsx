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
        'flex flex-col min-w-0 flex-1 bg-secondary/60 border border-border/60 rounded-2xl overflow-hidden',
        className
      )}
    >
      <header className="flex items-center gap-2 px-4 py-3 shrink-0">
        <h3 className="text-sm font-semibold text-high uppercase tracking-wide">
          {title}
        </h3>
        {count !== null && (
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-secondary text-xs font-medium text-low tabular-nums border border-border/50">
            {count}
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 pt-1 flex flex-col gap-2.5">
        {children}
      </div>
    </section>
  );
}
