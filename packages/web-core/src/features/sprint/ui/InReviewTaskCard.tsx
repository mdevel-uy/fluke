import { GitPullRequest } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { WorkerTask } from '@/features/sprint/types';

interface InReviewTaskCardProps {
  task: WorkerTask;
}

function stateBadgeClass(state: string | null | undefined): string {
  const normalized = (state ?? '').toLowerCase();
  if (normalized === 'merged')
    return 'bg-merged/10 text-merged border border-merged/20';
  if (normalized === 'closed')
    return 'bg-secondary text-low border border-border/60';
  if (normalized === 'open')
    return 'bg-success/10 text-success border border-success/20';
  return 'bg-secondary text-normal border border-border/60';
}

export function InReviewTaskCard({ task }: InReviewTaskCardProps) {
  const prUrl = task.pr_url ?? null;
  const prState = task.pr_state ?? null;

  return (
    <article className="group flex flex-col gap-2.5 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card hover:border-border">
      <p
        className="text-sm text-high font-medium leading-snug line-clamp-2"
        title={task.title}
      >
        {task.title}
      </p>
      {(prUrl || prState) && (
        <div className="flex items-center gap-2 flex-wrap">
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand-hover hover:underline"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              <span className="truncate max-w-[10rem]">{prUrl}</span>
            </a>
          )}
          {prState && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
                stateBadgeClass(prState)
              )}
            >
              {prState}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
