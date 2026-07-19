import type { RepoIssueResponse } from 'shared/types';

export type IssueState = 'open' | 'closed';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low';
export type IssueLabel = { name: string; color: string };

// Extends RepoIssueResponse with Kanban PRO backend contract fields.
// labels is overridden to the new { name, color } shape; milestone and priority
// are new fields. When the backend merges, shared/types.ts will be regenerated
// to match and this overlay becomes a no-op.
export type RepoIssue = Omit<RepoIssueResponse, 'labels'> & {
  labels: IssueLabel[];
  milestone: string | null;
  priority: IssuePriority | null;
};
