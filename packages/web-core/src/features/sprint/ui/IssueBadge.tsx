import { cn } from '@/shared/lib/utils';

interface IssueBadgeProps {
  issueNumber: number;
  className?: string;
}

export function IssueBadge({ issueNumber, className }: IssueBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border border-border/60 bg-secondary px-1.5 py-px font-mono text-[11px] leading-4 text-normal',
        className
      )}
    >
      #{issueNumber}
    </span>
  );
}

/**
 * Worker task titles are stored as `#<issue> <title>`. When the issue number
 * is rendered as a badge, strip the duplicated prefix from the visible title.
 */
export function taskDisplayTitle(task: {
  title: string;
  issue_number: number | null;
}): string {
  if (task.issue_number == null) return task.title;
  const prefix = `#${task.issue_number} `;
  return task.title.startsWith(prefix)
    ? task.title.slice(prefix.length)
    : task.title;
}
