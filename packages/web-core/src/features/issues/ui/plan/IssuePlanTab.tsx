import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IssuePhase, IssuePlanResponse } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { instanceLabel } from '@/features/workers/model/instance';
import { PhaseGraph, phaseKey, usePhaseLabel } from './PhaseGraph';

/**
 * "Plan" tab of the issue page (#686): phase graph, detail of the selected
 * phase and the phase templates, as in "3 · Issue" of
 * design/mockups/fluke-v2/pantallas.html.
 */

const TEMPLATES: { key: string; phases: string[]; gates?: string[] }[] = [
  { key: 'tdd', phases: ['tdd', 'dev', 'test', 'review', 'merge'] },
  { key: 'no_tdd', phases: ['dev', 'test', 'review', 'merge'] },
  {
    key: 'design',
    phases: ['design', 'approval', 'withOrWithoutTdd'],
    gates: ['approval'],
  },
  {
    key: 'bug',
    phases: ['reproduce', 'failingTest', 'fix', 'review', 'merge'],
  },
  {
    key: 'decision',
    phases: ['decision', 'baseTemplate'],
    gates: ['decision'],
  },
];

function duration(p: IssuePhase) {
  if (!p.started_at) return null;
  const start = Date.parse(p.started_at.replace(' ', 'T') + 'Z');
  const end = p.finished_at
    ? Date.parse(p.finished_at.replace(' ', 'T') + 'Z')
    : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const min = Math.max(1, Math.round((end - start) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Phase to select first: the one in progress or stuck, else the last done. */
function defaultSelection(phases: IssuePhase[]) {
  const live = phases.find((p) => p.state === 'active' || p.state === 'stuck');
  if (live) return phaseKey(live);
  const done = [...phases].reverse().find((p) => p.state !== 'pending');
  return done ? phaseKey(done) : null;
}

export function IssuePlanTab({ plan }: { plan: IssuePlanResponse }) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const label = usePhaseLabel(plan.phases);
  const [selected, setSelected] = useState<string | null>(() =>
    defaultSelection(plan.phases)
  );
  useEffect(() => {
    if (!selected || !plan.phases.some((p) => phaseKey(p) === selected)) {
      setSelected(defaultSelection(plan.phases));
    }
  }, [plan.phases, selected]);
  const phase = plan.phases.find((p) => phaseKey(p) === selected);

  return (
    <div className="grid gap-3.5">
      <PhaseGraph
        phases={plan.phases}
        selected={selected}
        onSelect={setSelected}
      />
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid content-start gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-4 py-3.5">
          {phase ? (
            <>
              <h3 className="m-0 text-[15px] font-semibold text-high">
                {label(phase)} · {t(`issues.plan.phases.kind.${phase.kind}`)}
              </h3>
              <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-normal">
                  {t('issues.plan.phases.profile')}
                </dt>
                <dd className="m-0 text-high">{phase.profile ?? '—'}</dd>
                <dt className="text-normal">
                  {t('issues.plan.phases.instance')}
                </dt>
                <dd className="m-0">
                  {phase.profile && phase.workspace_id ? (
                    <>
                      <code className="rounded border border-md-outline-variant bg-md-surface-container-lowest px-1 font-mono text-xs">
                        {instanceLabel(phase.profile, phase.workspace_id)}
                      </code>{' '}
                      <span className="text-normal">
                        {t('issues.plan.phases.ephemeral')}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt className="text-normal">
                  {t('issues.plan.phases.status')}
                </dt>
                <dd className="m-0 text-high">
                  {t(`issues.plan.phases.state.${phase.state}`)}
                </dd>
                {duration(phase) && (
                  <>
                    <dt className="text-normal">
                      {t('issues.plan.phases.duration')}
                    </dt>
                    <dd className="m-0 text-high">{duration(phase)}</dd>
                  </>
                )}
                {phase.cost_usd != null && (
                  <>
                    <dt className="text-normal">
                      {t('issues.plan.phases.cost')}
                    </dt>
                    <dd className="m-0 text-high">
                      ${phase.cost_usd.toFixed(2)}
                    </dd>
                  </>
                )}
              </dl>
              {phase.output && (
                <>
                  <p className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
                    {t('issues.plan.phases.output')}
                  </p>
                  <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-md border border-md-outline-variant bg-md-surface-container-lowest px-3 py-2.5 font-mono text-xs leading-relaxed text-high">
                    {phase.output}
                  </pre>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                {phase.workspace_id && (
                  <button
                    type="button"
                    onClick={() =>
                      appNavigation.goToWorkspace(phase.workspace_id!)
                    }
                    className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
                  >
                    {t('issues.plan.phases.viewSession')}
                  </button>
                )}
                {phase.state === 'changes' && plan.pr_url && (
                  <a
                    href={plan.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
                  >
                    {t('issues.plan.phases.viewPrComments')}
                  </a>
                )}
              </div>
            </>
          ) : (
            <p className="m-0 text-[13px] text-normal">
              {t('issues.plan.phases.selectHint')}
            </p>
          )}
        </div>

        <div className="grid content-start gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-4 py-3.5">
          <h3 className="m-0 text-[15px] font-semibold text-high">
            {t('issues.plan.templates.title')}
          </h3>
          <p className="m-0 text-xs text-normal">
            {t('issues.plan.templates.hint')}
          </p>
          <div className="grid gap-1.5">
            {TEMPLATES.map((tpl) => (
              <div
                key={tpl.key}
                className="flex flex-wrap items-center gap-1 text-xs"
              >
                <b
                  className={cn(
                    'w-full text-[12.5px] font-medium',
                    tpl.key === plan.template ? 'text-md-primary' : 'text-high'
                  )}
                >
                  {t(`issues.plan.templates.names.${tpl.key}`)}
                </b>
                {tpl.phases.map((ph) => (
                  <span
                    key={ph}
                    className={cn(
                      'rounded border px-[5px] py-px font-mono text-[10.5px]',
                      tpl.gates?.includes(ph)
                        ? 'border-warning text-warning'
                        : 'border-md-outline-variant text-normal'
                    )}
                  >
                    {t(`issues.plan.templates.phases.${ph}`)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
