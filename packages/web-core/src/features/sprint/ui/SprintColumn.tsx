import type { ReactNode } from 'react';
import { BoardColumn } from '@/workbench/ui/board';

export function SprintColumn({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count: number | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BoardColumn title={title} count={count} className={className}>
      {children}
    </BoardColumn>
  );
}
