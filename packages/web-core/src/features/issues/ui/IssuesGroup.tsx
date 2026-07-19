import type { RepoIssue } from '@/features/issues/types';
import { IssueListItem } from './IssueListItem';

interface IssuesGroupProps {
  title: string;
  count: number;
  issues: RepoIssue[];
  repoId: string | undefined;
}

export function IssuesGroup({
  title,
  count,
  issues,
  repoId,
}: IssuesGroupProps) {
  if (issues.length === 0) return null;

  return (
    <section className="flex flex-col mx-6 rounded-2xl border border-border/60 bg-primary shadow-soft overflow-hidden">
      <header className="flex items-center gap-2 px-5 py-3 bg-secondary/40 border-b border-border/60">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-high">
          {title}
        </h3>
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-secondary text-xs font-medium text-low tabular-nums border border-border/50">
          {count}
        </span>
      </header>
      <ul className="flex flex-col">
        {issues.map((issue) => (
          <IssueListItem key={issue.id} issue={issue} repoId={repoId} />
        ))}
      </ul>
    </section>
  );
}
