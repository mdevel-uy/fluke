import type { IssueLabel, RepoIssueResponse } from 'shared/types';

export type { IssueLabel };
export type IssueState = 'open' | 'closed';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low';
export type RepoIssue = RepoIssueResponse;
