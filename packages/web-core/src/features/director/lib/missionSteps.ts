import type { MissionDetail } from 'shared/types';

/**
 * Steps of a mission (fluke v2, #700; mockup "1 · Fluke", "Estado de la
 * misión"): Entender → Brief + plantilla → Despiece → Plan interno →
 * Ejecución. `current` is the index of the step in progress; `STEPS.length`
 * when everything is done.
 */
export const STEPS = [
  'understand',
  'brief',
  'breakdown',
  'plan',
  'run',
] as const;

export function currentStep(detail: MissionDetail): number {
  const { status } = detail.mission;
  const proposal = detail.proposal;
  if (status === 'draft' || status === 'clarifying') return 0;
  if (status === 'brief_ready') return 1;
  if (
    status === 'closed' ||
    (proposal.length > 0 && proposal.every((i) => i.state !== 'open'))
  ) {
    return STEPS.length;
  }
  // The breakdown is over when the Analyst finished and left issues.
  if (detail.analyst_status !== 'done' || proposal.length === 0) return 2;
  if (detail.execution === 'running') return 4;
  if (detail.execution === 'planning') return 3;
  // Issues ready, nothing dispatched: still the breakdown's closing, where
  // Fluke offers "Ver milestone" / "Ejecutar ahora".
  return 2;
}

/** The breakdown is done and nothing runs yet: time to offer the play. */
export function readyToRun(detail: MissionDetail): boolean {
  return (
    detail.mission.status !== 'closed' &&
    detail.analyst_status === 'done' &&
    detail.proposal.some((i) => i.state === 'open') &&
    detail.execution === 'none'
  );
}

/** Milestones of the proposal, in wave order of their first issue. */
export function proposalMilestones(detail: MissionDetail): string[] {
  return [
    ...new Set(
      detail.proposal
        .filter((i) => i.milestone)
        .map((i) => i.milestone as string)
    ),
  ];
}

/** Template the brief chose: TDD and design, from the brief's items. */
export function briefTemplate(detail: MissionDetail) {
  const items = detail.items.map((v) => v.item);
  return {
    tdd: items.some((i) => /^(s[ií]|yes)/i.test(i.fields.tdd ?? '')),
    design: items.some((i) => i.kind === 'design'),
  };
}
