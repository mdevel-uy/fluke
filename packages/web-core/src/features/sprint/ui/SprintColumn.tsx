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
        'flex flex-col min-w-0 flex-1 bg-secondary border border-border rounded-md overflow-hidden',
        className
      )}
    >
      <header className="flex items-center gap-half px-base py-half border-b border-border shrink-0">
        <h3 className="text-sm font-semibold text-normal">{title}</h3>
        {count !== null && <span className="text-xs text-low">({count})</span>}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-half flex flex-col gap-half">
        {children}
      </div>
    </section>
  );
}
