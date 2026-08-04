import type { RepoIssue } from '@/features/issues/types';

export function buildAssignToAgentPrompt(issue: RepoIssue): string {
  const body = issue.body?.trim() ?? '';
  const bodySection = body ? `${body}\n\n` : '';
  return `Resolvé el issue #${issue.number}: ${issue.title}

${bodySection}Antes de empezar, corré \`gh issue view ${issue.number} --comments\` para leer la discusión completa. Cuando el trabajo esté listo, el PR debe incluir 'Closes #${issue.number}' en su descripción.`;
}
