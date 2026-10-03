import { useTranslation } from 'react-i18next';
import type { MissionDetail } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import {
  useMilestoneRunActions,
  usePlanStepModeStore,
} from '@/features/issues/model/useMilestoneRuns';
import { usePlanCollapseStore } from '@/features/issues/model/usePlanCollapseStore';
import { rememberIssuesView } from '@/features/issues/model/issuesView';
import {
  STEPS,
  briefTemplate,
  currentStep,
  proposalMilestones,
  readyToRun,
} from '../lib/missionSteps';
import { useDirectorStore } from '../model/useDirectorStore';

/**
 * Mission progress (fluke v2, #700), as in "1 · Fluke" of
 * design/mockups/fluke-v2/pantallas.html: the "Estado de la misión" stepper,
 * the "Propuesta del Analyst" panel and Fluke's closing message with "Ver
 * milestone" / "Ejecutar ahora".
 */

function Panel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low p-3.5">
      <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
        {label}
      </p>
      {children}
    </div>
  );
}

export function MissionStepper({ detail }: { detail: MissionDetail }) {
  const { t } = useTranslation('common');
  const current = currentStep(detail);
  const template = briefTemplate(detail);
  const version = detail.briefs.at(-1)?.version ?? 1;
  const milestones = proposalMilestones(detail);
  const waves = new Set(detail.proposal.map((i) => i.wave)).size;

  const sub = (step: (typeof STEPS)[number], done: boolean) => {
    if (!done) return t(`director.steps.${step}.todo`);
    switch (step) {
      case 'brief':
        return t('director.steps.brief.done', {
          v: version,
          template: t(
            `director.steps.template.${template.tdd ? 'tdd' : 'noTdd'}${template.design ? 'Design' : 'NoDesign'}`
          ),
        });
      case 'breakdown':
        return t('director.steps.breakdown.done', {
          issues: detail.proposal.length,
          waves,
        });
      default:
        return t(`director.steps.${step}.done`);
    }
  };

  return (
    <Panel label={t('director.steps.title')}>
      <ol className="m-0 grid list-none p-0">
        {STEPS.map((step, i) => {
          const done = i < current;
          const cur = i === current;
          return (
            <li
              key={step}
              aria-current={cur ? 'step' : undefined}
              className="relative grid grid-cols-[18px_1fr] gap-2.5 pb-3 text-[13px] last:pb-0"
            >
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-2 top-[18px] border-l-[1.5px] border-md-outline-variant"
                />
              )}
              <i
                className={cn(
                  'relative z-[1] grid size-[18px] place-items-center rounded-full border-[1.5px] border-md-outline bg-md-surface-container-low font-mono text-[10px] font-semibold not-italic',
                  done && 'border-success bg-success text-black',
                  cur && 'border-md-primary text-md-primary'
                )}
              >
                {done ? '✓' : i + 1}
              </i>
              <div>
                <b
                  className={cn('font-medium text-normal', cur && 'text-high')}
                >
                  {t(`director.steps.${step}.title`)}
                </b>
                <small className="block text-xs text-normal">
                  {sub(step, done)}
                  {step === 'run' && cur && milestones.length > 0
                    ? ` · ${milestones.join(', ')}`
                    : ''}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** "Ver milestone": the Plan view of Issues with the mission's bands open. */
function useShowMilestones(detail: MissionDetail) {
  const appNavigation = useAppNavigation();
  const setView = useDirectorStore((s) => s.setView);
  return () => {
    const { collapsed, toggle } = usePlanCollapseStore.getState();
    for (const m of proposalMilestones(detail)) {
      if (collapsed.includes(m)) toggle(m);
    }
    rememberIssuesView('plan');
    if (useDirectorStore.getState().view === 'expanded') setView('panel');
    appNavigation.goToIssues(detail.mission.repo_id ?? undefined);
  };
}

export function ProposalPanel({ detail }: { detail: MissionDetail }) {
  const { t } = useTranslation('common');
  const show = useShowMilestones(detail);
  if (detail.proposal.length === 0) return null;
  const several = proposalMilestones(detail).length > 1;
  const byWave = new Map<string, MissionDetail['proposal']>();
  for (const issue of [...detail.proposal].sort(
    (a, b) => (a.wave ?? 99) - (b.wave ?? 99) || a.number - b.number
  )) {
    const key = `${several ? `${issue.milestone ?? '—'} · ` : ''}${
      issue.wave !== null ? `W${issue.wave}` : '—'
    }`;
    byWave.set(key, [...(byWave.get(key) ?? []), issue]);
  }
  return (
    <Panel label={t('director.proposal.title')}>
      <div className="grid gap-1.5">
        {[...byWave.entries()].map(([wave, issues]) => (
          <div
            key={wave}
            className="grid grid-cols-[38px_1fr] items-start gap-2 text-[12.5px]"
          >
            <span className="pt-px font-mono text-[11px] font-medium text-normal">
              {wave}
            </span>
            <span className="grid gap-0.5 text-high">
              {issues.map((i) => (
                <span key={i.number}>
                  #{i.number} {i.title}
                  {i.decision && (
                    <span className="ml-1.5 rounded border border-warning px-1.5 py-px font-mono text-[10px] font-medium text-warning">
                      {t('director.proposal.decision')}
                    </span>
                  )}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={show}
        className="inline-flex h-8 w-fit items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
      >
        {t('director.proposal.openInIssues')}
      </button>
    </Panel>
  );
}

/** Fluke's closing of the breakdown, above the composer. */
export function ProposalMessage({ detail }: { detail: MissionDetail }) {
  const { t } = useTranslation('common');
  const show = useShowMilestones(detail);
  const repoId = detail.mission.repo_id ?? undefined;
  const actions = useMilestoneRunActions(repoId);
  const stepMode = usePlanStepModeStore((s) => s.stepMode);
  if (!readyToRun(detail)) return null;
  const milestones = proposalMilestones(detail);
  const waves = new Set(detail.proposal.map((i) => i.wave)).size;
  const run = () =>
    milestones.length === 1
      ? actions.play.mutate({ milestone: milestones[0], stepMode })
      : actions.playAll.mutate({ milestones, stepMode });
  const pending = actions.play.isPending || actions.playAll.isPending;
  return (
    <div className="grid gap-1.5 px-3 pb-2">
      <span className="font-mono text-[11px] text-normal">Fluke</span>
      <div className="rounded-[10px] border border-md-outline-variant bg-md-surface-container-high px-3 py-2.5 text-[13.5px] leading-normal text-high">
        {t('director.proposal.message', {
          issues: detail.proposal.length,
          waves,
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={show}
          className="rounded-full border border-md-primary px-2.5 py-[3px] text-xs text-md-primary hover:bg-md-primary/10"
        >
          {t('director.proposal.viewMilestone')}
        </button>
        <button
          type="button"
          disabled={!repoId || milestones.length === 0 || pending}
          onClick={run}
          className="rounded-full border border-md-primary px-2.5 py-[3px] text-xs text-md-primary hover:bg-md-primary/10 disabled:opacity-50"
        >
          {t('director.proposal.runNow')}
        </button>
      </div>
    </div>
  );
}
