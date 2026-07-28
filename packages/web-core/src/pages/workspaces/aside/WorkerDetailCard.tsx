import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { StatusDot, type DotTone } from './primitives';

// SHELL-SPEC R19: worker card — identity first (name + role chip), the model
// is an attribute line (R31), context bar with % used, and Stop / Start task.

const ROLE_CHIP_CLASS: Record<string, string> = {
  developer: 'bg-info/10 text-info',
  analyst: 'bg-brand/10 text-brand-on-surface',
  reviewer: 'bg-warning/10 text-warning',
};

export type WorkerCardState = 'running' | 'attention' | 'idle';

export interface WorkerDetailCardProps {
  /** No agent has ever run here — renders the compact idle variant */
  noAgent?: boolean;
  name?: string;
  role?: string;
  model?: string;
  lastActivity?: string;
  /** 0-100; undefined hides the context bar */
  contextPct?: number;
  state: WorkerCardState;
  attentionLabel?: string;
  elapsed?: string;
  onStop?: () => void;
  isStopping?: boolean;
  onStart?: () => void;
}

function cardDotTone(state: WorkerCardState): DotTone {
  if (state === 'running') return 'run';
  if (state === 'attention') return 'warn';
  return 'idle';
}

const ACTION_BUTTON_CLASS = cn(
  'h-[22px] rounded-[5px] border border-border-strong px-[9px] text-[11px] text-normal',
  'hover:bg-secondary hover:text-high cursor-pointer',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
);

export function WorkerDetailCard({
  noAgent = false,
  name,
  role,
  model,
  lastActivity,
  contextPct,
  state,
  attentionLabel,
  elapsed,
  onStop,
  isStopping = false,
  onStart,
}: WorkerDetailCardProps) {
  const { t } = useTranslation('common');

  if (noAgent) {
    return (
      <div className="mx-2.5 mt-2 mb-2 rounded-lg border border-border bg-panel px-2.5 py-2">
        <div className="mb-1.5 flex items-center gap-1.5">
          <StatusDot tone="idle" />
          <span className="flex-1 text-sm font-semibold text-high">
            {t('workspaces.aside.noAgent', { defaultValue: 'No agent running' })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-low">
            {t('workspaces.aside.workspaceIdle', {
              defaultValue: 'Workspace idle',
            })}
          </span>
          {onStart && (
            <button
              type="button"
              onClick={onStart}
              className={ACTION_BUTTON_CLASS}
            >
              {t('workspaces.aside.startTask', { defaultValue: 'Start task' })}
            </button>
          )}
        </div>
      </div>
    );
  }

  const footer =
    state === 'attention'
      ? (attentionLabel ??
        t('workspaces.aside.needsAttention', {
          defaultValue: 'Needs attention',
        }))
      : state === 'running'
        ? [
            t('workspaces.aside.working', { defaultValue: 'Working…' }),
            elapsed,
          ]
            .filter(Boolean)
            .join(' · ')
        : t('workspaces.aside.workspaceIdle', { defaultValue: 'Workspace idle' });

  return (
    <div
      className={cn(
        'mx-2.5 mt-2 mb-2 rounded-lg border bg-panel px-2.5 py-2',
        state === 'attention' ? 'border-warning/45' : 'border-border'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <StatusDot tone={cardDotTone(state)} />
        <span className="flex-1 truncate text-sm font-semibold text-high">
          {name ??
            t('workspaces.aside.unknownWorker', { defaultValue: 'Agent' })}
        </span>
        {role && (
          <span
            className={cn(
              'flex-none rounded px-1.5 py-0.5 text-xs font-medium capitalize',
              ROLE_CHIP_CLASS[role] ?? 'bg-secondary text-low'
            )}
          >
            {role}
          </span>
        )}
      </div>

      <div className="flex min-w-0 gap-1.5 py-px text-sm text-normal">
        <span className="w-[46px] flex-none text-[10px] font-semibold uppercase leading-[18px] tracking-wider text-low">
          {t('workspaces.aside.model', { defaultValue: 'Model' })}
        </span>
        <span className="truncate font-mono text-[12px]">{model ?? '—'}</span>
      </div>
      {lastActivity && (
        <div className="flex min-w-0 gap-1.5 py-px text-sm text-normal">
          <span className="w-[46px] flex-none text-[10px] font-semibold uppercase leading-[18px] tracking-wider text-low">
            {t('workspaces.aside.last', { defaultValue: 'Last' })}
          </span>
          <span className="truncate">{lastActivity}</span>
        </div>
      )}

      {contextPct !== undefined && (
        <>
          <div className="mt-2 h-1 overflow-hidden rounded-sm bg-secondary">
            <i
              className={cn(
                'block h-full rounded-sm',
                contextPct >= 90
                  ? 'bg-error'
                  : contextPct >= 75
                    ? 'bg-warning'
                    : 'bg-brand-on-surface'
              )}
              style={{ width: `${Math.min(100, Math.max(0, contextPct))}%` }}
            />
          </div>
          <div className="mt-[3px] text-[10px] text-low">
            {t('workspaces.aside.contextPct', {
              defaultValue: 'context {{pct}}%',
              pct: Math.round(contextPct),
            })}
          </div>
        </>
      )}

      <div className="mt-[7px] flex items-center gap-2">
        <span className="flex-1 truncate text-[11px] text-low">{footer}</span>
        {state === 'running' && onStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            className={ACTION_BUTTON_CLASS}
          >
            {isStopping
              ? t('workspaces.aside.stopping', { defaultValue: 'Stopping…' })
              : t('workspaces.aside.stop', { defaultValue: 'Stop' })}
          </button>
        ) : state !== 'running' && onStart ? (
          <button
            type="button"
            onClick={onStart}
            className={ACTION_BUTTON_CLASS}
          >
            {t('workspaces.aside.startTask', { defaultValue: 'Start task' })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
