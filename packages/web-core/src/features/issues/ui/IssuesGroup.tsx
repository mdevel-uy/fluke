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
    <section className="flex flex-col">
      <header className="flex items-center gap-half px-base py-half border-b border-border">
        <h3 className="text-sm font-semibold text-normal">{title}</h3>
        <span className="text-xs text-low">({count})</span>
      </header>
      <ul className="flex flex-col">
        {issues.map((issue) => (
          <IssueListItem key={issue.id} issue={issue} repoId={repoId} />
        ))}
      </ul>
    </section>
  );
}
