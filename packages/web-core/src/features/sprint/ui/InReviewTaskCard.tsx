import { GitPullRequestIcon } from '@phosphor-icons/react';
import { cn } from '@/shared/lib/utils';
import type { WorkerTask } from '@/features/sprint/types';

interface InReviewTaskCardProps {
  task: WorkerTask;
}

function stateClassName(state: string | null | undefined): string {
  const normalized = (state ?? '').toLowerCase();
  if (normalized === 'merged') return 'bg-brand/10 text-brand';
  if (normalized === 'closed') return 'bg-panel text-low';
  return 'bg-panel text-normal';
}

export function InReviewTaskCard({ task }: InReviewTaskCardProps) {
  const prUrl = task.pr_url ?? null;
  const prState = task.pr_state ?? null;

  return (
    <article className="flex flex-col gap-half p-base bg-primary border border-border rounded-sm">
      <p
        className="text-sm text-normal font-medium truncate"
        title={task.title}
      >
        {task.title}
      </p>
      {(prUrl || prState) && (
        <div className="flex items-center gap-half flex-wrap">
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-half text-xs text-brand hover:underline"
            >
              <GitPullRequestIcon className="size-icon-sm" weight="bold" />
              <span className="truncate max-w-[10rem]">{prUrl}</span>
            </a>
          )}
          {prState && (
            <span
              className={cn(
                'inline-flex items-center h-5 px-base rounded-sm text-xs font-medium uppercase',
                stateClassName(prState)
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
