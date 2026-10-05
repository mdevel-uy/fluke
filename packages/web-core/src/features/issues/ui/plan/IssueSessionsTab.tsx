import { useTranslation } from 'react-i18next';
import { phaseKindLabel } from '@/features/issues/lib/phaseLabel';
import type { IssuePhase } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { instanceLabel } from '@/features/workers/model/instance';
import { phaseKey, usePhaseLabel } from './PhaseGraph';
import { EmbeddedSessionChat } from './EmbeddedSessionChat';

/**
 * "Sesiones" tab of the issue page (#689): one session per phase that ran,
 * live for the active (or stuck) one and read-only for the rest, as in
 * "3 · Issue" of design/mockups/fluke-v2/pantallas.html.
 */

const STATE_TEXT: Record<string, string> = {
  done: 'text-success',
  active: 'text-md-primary',
  changes: 'text-violet-600 dark:text-violet-400',
  stuck: 'text-md-error',
};

/** Phases that can run more than once, besides the gates of profiles. */
const ROUND_KINDS = ['dev', 'review', 'test', 'quality', 'security'];

export function IssueSessionsTab({
  phases,
  selected,
  onSelect,
}: {
  phases: IssuePhase[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation('common');
  const label = usePhaseLabel(phases);
  const ran = phases.filter((p) => p.workspace_id);
  const current = ran.find((p) => phaseKey(p) === selected) ?? ran.at(-1);

  if (!current) {
    return (
      <p className="m-0 py-6 text-[13px] text-normal">
        {t('issues.plan.sessions.empty')}
      </p>
    );
  }
  const live = current.state === 'active' || current.state === 'stuck';

  return (
    <div className="grid min-h-[520px] overflow-hidden rounded-[10px] border border-md-outline-variant bg-md-surface-container-low lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="grid content-start gap-1 border-b border-md-outline-variant p-2.5 lg:border-b-0 lg:border-r">
        <p className="m-0 px-1 pb-1.5 pt-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
          {t('issues.plan.sessions.onePerPhase')}
        </p>
        {ran.map((p) => {
          const key = phaseKey(p);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={cn(
                'grid grid-cols-[1fr_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg border border-transparent px-2.5 py-2 text-left hover:bg-md-on-surface/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary',
                key === phaseKey(current) &&
                  'border-md-outline-variant bg-md-surface-container-high'
              )}
            >
              <b className="text-[13px] font-medium text-high">
                {phaseKindLabel(t, p.kind, p.profile)}
                {(ROUND_KINDS.includes(p.kind) || p.kind.startsWith('gate:')) &&
                  ` · r${p.round}`}
              </b>
              <span
                className={cn('text-[11px] text-normal', STATE_TEXT[p.state])}
              >
                {t(`issues.plan.phases.state.${p.state}`)}
              </span>
              <small className="col-span-2 font-mono text-[11px] text-normal">
                {p.profile ? instanceLabel(p.profile, p.workspace_id) : '—'}
              </small>
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-md-outline-variant bg-md-surface-container px-4 py-2.5 text-[13px]">
          <b className="font-semibold text-high">
            {label(current)} ·{' '}
            {phaseKindLabel(t, current.kind, current.profile)}
          </b>
          {current.profile && (
            <code className="rounded border border-md-outline-variant bg-md-surface-container-lowest px-1 font-mono text-xs">
              {instanceLabel(current.profile, current.workspace_id)}
            </code>
          )}
          <span className="flex-1" />
          <span
            className={cn(
              'text-xs text-normal',
              current.state === 'stuck' && 'text-md-error'
            )}
          >
            {current.state === 'stuck'
              ? t('issues.plan.sessions.waitingYou')
              : live
                ? t('issues.plan.sessions.live')
                : t('issues.plan.sessions.readOnly')}
          </span>
        </div>
        <div className="flex h-[480px] min-h-0 flex-col">
          <EmbeddedSessionChat
            key={current.workspace_id!}
            workspaceId={current.workspace_id!}
            live={live}
          />
        </div>
        {!live && (
          <div className="border-t border-md-outline-variant px-4 py-2.5 text-xs text-normal">
            {t('issues.plan.sessions.discarded')}
          </div>
        )}
      </div>
    </div>
  );
}
