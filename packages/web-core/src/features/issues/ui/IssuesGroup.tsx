import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueListItem } from './IssueListItem';

interface IssuesGroupProps {
  title: string;
  count: number;
  issues: RepoIssue[];
  repoId: string | undefined;
  taskByIssueNumber: Map<number, WorkerTask>;
}

export function IssuesGroup({
  title,
  count,
  issues,
  repoId,
  taskByIssueNumber,
}: IssuesGroupProps) {
  if (issues.length === 0) return null;

  return (
    <section className="flex flex-col mx-6 rounded-lg border border-md-outline-variant bg-md-surface-container-lowest shadow-card overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 bg-md-surface-container-low border-b border-md-outline-variant">
        <h3 className="text-label-caps font-geist font-semibold uppercase tracking-widest text-md-on-surface">
          {title}
        </h3>
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-[18px] px-1.5 rounded-full bg-md-primary text-md-on-primary text-label-caps font-geist font-semibold tabular-nums">
          {count}
        </span>
      </header>
      <ul className="flex flex-col">
        {issues.map((issue) => (
          <IssueListItem
            key={issue.id}
            issue={issue}
            repoId={repoId}
            linkedTask={taskByIssueNumber.get(issue.number)}
          />
        ))}
      </ul>
    </section>
  );
}
