export const repoIssuesKeys = {
  all: ['repo-issues'] as const,
  byRepo: (repoId: string) => [...repoIssuesKeys.all, repoId] as const,
};
