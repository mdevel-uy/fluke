import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IssuePhase, IssuePlanResponse } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { instanceLabel } from '@/features/workers/model/instance';
import { PhaseGraph, phaseKey, usePhaseLabel } from './PhaseGraph';

/**
 * "Plan" tab of the issue page (#686): phase graph, detail of the selected
 * phase and, when stuck, the stuck kinds, as in "3 · Issue" of
 * design/mockups/fluke-v2/pantallas.html.
 */

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

const STUCK_KINDS = [
  'question',
  'failed',
  'review_cap',
  'no_progress',
  'credential',
  'conflict',
] as const;

export function IssuePlanTab({
  plan,
  onOpenSession,
  onUnstick,
}: {
  plan: IssuePlanResponse;
  /** Opens the phase's session in the Sesiones tab (#689). */
  onOpenSession: (phaseKey: string) => void;
  onUnstick: () => void;
}) {
  const { t } = useTranslation('common');
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
      <div
        className={cn(
          'grid gap-3.5',
          plan.blocker && 'lg:grid-cols-[minmax(0,1fr)_300px]'
        )}
      >
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
                    onClick={() => onOpenSession(phaseKey(phase))}
                    className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high hover:border-md-on-surface-variant"
                  >
                    {t('issues.plan.phases.viewSession')}
                  </button>
                )}
                {phase.state === 'stuck' && plan.blocker && (
                  <button
                    type="button"
                    onClick={onUnstick}
                    className="inline-flex h-8 items-center rounded-md border border-md-error bg-md-error px-3 text-[13px] font-semibold text-md-on-error"
                  >
                    {t('issues.plan.stuck.unstick')}
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

        {plan.blocker && (
          <div className="grid content-start gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-4 py-3.5">
            <h3 className="m-0 text-[15px] font-semibold text-high">
              {t('issues.plan.stuck.kindsTitle')}
            </h3>
            <ol className="m-0 grid gap-1.5 pl-[18px] text-[13px] text-high">
              {STUCK_KINDS.map((kind) => (
                <li key={kind}>
                  {t(`issues.plan.stuck.kinds.${kind}.title`)}.{' '}
                  <span className="text-normal">
                    {kind === plan.blocker?.kind
                      ? t('issues.plan.stuck.thisCase')
                      : t(`issues.plan.stuck.kinds.${kind}.hint`)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="m-0 text-xs text-normal">
              {t('issues.plan.stuck.kindsNote')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
