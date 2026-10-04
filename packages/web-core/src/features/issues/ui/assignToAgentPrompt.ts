import type { RepoIssue } from '@/features/issues/types';

/** Marker of a design issue (#756), same label the milestone run reads. */
const DESIGN_LABEL = 'kind:design';

/** Design issues go only to a Designer, never to a developer (#756). */
export function isDesignIssue(issue: Pick<RepoIssue, 'labels'>): boolean {
  return issue.labels.some(
    (l) => l.name.trim().toLowerCase() === DESIGN_LABEL
  );
}

/**
 * Same text the backend builds (`issue_prompt` / `design_issue_prompt` in
 * milestone_runs.rs). A design issue asks for no PR: the Designer never
 * opens one, the issue is done when the user approves the design.
 */
export function buildAssignToAgentPrompt(issue: RepoIssue): string {
  const body = issue.body?.trim() ?? '';
  const bodySection = body ? `${body}\n\n` : '';
  if (isDesignIssue(issue)) {
    return `Diseñá el issue #${issue.number}: ${issue.title}

${bodySection}Antes de empezar, corré \`gh issue view ${issue.number} --comments\` para leer la discusión completa. Entregá el diseño commiteado en \`design/\`, sin abrir un PR: el issue queda resuelto cuando el user aprueba el diseño.`;
  }
  return `Resolvé el issue #${issue.number}: ${issue.title}

${bodySection}Antes de empezar, corré \`gh issue view ${issue.number} --comments\` para leer la discusión completa. Cuando el trabajo esté listo, el PR debe incluir 'Closes #${issue.number}' en su descripción.`;
}
