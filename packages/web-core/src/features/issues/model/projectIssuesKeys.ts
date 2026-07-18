export const projectIssuesKeys = {
  all: ['project-issues'] as const,
  byProject: (projectId: string) =>
    [...projectIssuesKeys.all, projectId] as const,
};
