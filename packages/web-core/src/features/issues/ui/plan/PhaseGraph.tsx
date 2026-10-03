import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IssuePhase } from 'shared/types';
import { cn } from '@/shared/lib/utils';

/**
 * Phase graph of the issue page (#686), "3 · Issue" of
 * design/mockups/fluke-v2/pantallas.html: phases left to right with arrows
 * colored by progress, and an arc from every review that asked for changes
 * back to the development round it sent back.
 */

export const PHASE_STATE_CLASS: Record<string, string> = {
  done: 'border-success/70',
  active:
    'border-md-primary shadow-[0_0_0_1px_hsl(var(--md-primary)/0.35),0_8px_24px_-12px_hsl(var(--md-primary))]',
  changes: 'border-violet-600 dark:border-violet-400',
  stuck:
    'border-md-error shadow-[0_0_0_1px_hsl(var(--md-error)/0.35),0_8px_24px_-12px_hsl(var(--md-error))]',
  pending: 'opacity-55',
};

const BADGE_CLASS: Record<string, string> = {
  done: 'bg-success/15 text-success',
  active: 'bg-md-primary/15 text-md-primary',
  changes: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  stuck: 'bg-md-error/15 text-md-error',
  pending: 'border border-md-outline-variant text-normal',
};

const STEP_DOT: Record<string, string> = {
  done: 'bg-success',
  active: 'bg-md-primary',
  cut: 'bg-md-outline',
  pending: 'bg-md-outline',
};

const ARROW_COLORS = {
  done: 'hsl(var(--_success))',
  loop: 'rgb(139 92 246)',
  pending: 'hsl(var(--md-outline))',
} as const;

export const phaseKey = (p: IssuePhase) => `${p.kind}-${p.round}`;

/** "Origen", "Fase n", "Vuelta" or "Fin", as in the mockup. */
export function usePhaseLabel(phases: IssuePhase[]) {
  const { t } = useTranslation('common');
  const order = [...new Set(phases.map((p) => p.kind))].filter(
    (k) => k !== 'origin' && k !== 'merge'
  );
  return (p: IssuePhase) => {
    if (p.kind === 'origin') return t('issues.plan.phases.origin');
    if (p.kind === 'merge') return t('issues.plan.phases.end');
    if (p.kind === 'dev' && p.round > 1) return t('issues.plan.phases.loop');
    return t('issues.plan.phases.phaseN', { n: order.indexOf(p.kind) + 1 });
  };
}

export function PhaseGraph({
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
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<
    {
      d: string;
      tone: keyof typeof ARROW_COLORS;
      dashed: boolean;
      label?: [number, number, string];
    }[]
  >([]);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const o = el.getBoundingClientRect();
    const r = (k: string) =>
      el.querySelector(`[data-phase="${k}"]`)?.getBoundingClientRect();
    const out: typeof paths = [];
    for (let i = 0; i < phases.length - 1; i++) {
      const a = r(phaseKey(phases[i]));
      const b = r(phaseKey(phases[i + 1]));
      if (!a || !b) continue;
      const y = a.top + 26 - o.top;
      const loop = phases[i].state === 'changes';
      const done = phases[i].state === 'done';
      out.push({
        d: `M${a.right - o.left} ${y} L${b.left - o.left - 2} ${y}`,
        tone: loop ? 'loop' : done ? 'done' : 'pending',
        dashed: !loop && !done,
      });
    }
    // Arc from a review that asked for changes back to the round it sent back.
    phases.forEach((p, i) => {
      if ((p.kind !== 'review' && p.kind !== 'test') || p.state !== 'changes')
        return;
      const back = [...phases.slice(0, i)]
        .reverse()
        .find((q) => q.kind === 'dev');
      const a = r(phaseKey(p));
      const b = back && r(phaseKey(back));
      if (!a || !b) return;
      const x1 = a.left + a.width / 2 - o.left;
      const x2 = b.left + b.width / 2 - o.left;
      const top = a.top - o.top;
      out.push({
        d: `M${x1} ${top - 2} C${x1} ${top - 46} ${x2} ${top - 46} ${x2} ${top - 4}`,
        tone: 'loop',
        dashed: true,
        label: [
          (x1 + x2) / 2,
          top - 40,
          t('issues.plan.phases.loopLabel', { n: p.round }),
        ],
      });
    });
    setPaths(out);
  }, [phases, t]);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      className="overflow-x-auto rounded-[10px] border border-md-outline-variant bg-md-surface-container-low"
      style={{
        backgroundImage:
          'radial-gradient(hsl(var(--md-on-surface) / 0.09) 1px, transparent 1px)',
        backgroundSize: '18px 18px',
      }}
    >
      <div
        ref={ref}
        className="relative flex min-w-max items-start gap-[38px] px-[22px] pb-[26px] pt-16"
      >
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <defs>
            {Object.entries(ARROW_COLORS).map(([id, color]) => (
              <marker
                key={id}
                id={`phase-arrow-${id}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0 0L8 4L0 8z" fill={color} />
              </marker>
            ))}
          </defs>
          {paths.map((p, i) => (
            <g key={i}>
              <path
                d={p.d}
                stroke={ARROW_COLORS[p.tone]}
                strokeWidth={1.7}
                fill="none"
                strokeDasharray={p.dashed ? '4 4' : undefined}
                markerEnd={`url(#phase-arrow-${p.tone})`}
              />
              {p.label && (
                <text
                  x={p.label[0]}
                  y={p.label[1]}
                  textAnchor="middle"
                  fill="rgb(139 92 246)"
                  fontSize={11}
                  className="font-mono"
                >
                  {p.label[2]}
                </text>
              )}
            </g>
          ))}
        </svg>
        {phases.map((p) => {
          const key = phaseKey(p);
          return (
            <button
              key={key}
              type="button"
              data-phase={key}
              onClick={() => onSelect(key)}
              className={cn(
                'relative z-[1] grid w-[158px] cursor-pointer gap-[5px] rounded-[10px] border border-md-outline-variant bg-md-surface-container-high px-3 py-2.5 text-left',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary',
                PHASE_STATE_CLASS[p.state],
                selected === key &&
                  'outline outline-2 outline-offset-[3px] outline-md-on-surface'
              )}
            >
              <span className="flex items-center justify-between font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-normal">
                {label(p)}
                <span
                  className={cn(
                    'rounded px-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]',
                    BADGE_CLASS[p.state]
                  )}
                >
                  {t(`issues.plan.phases.state.${p.state}`)}
                </span>
              </span>
              <b className="text-[13.5px] font-semibold text-high">
                {t(`issues.plan.phases.kind.${p.kind}`)}
              </b>
              {p.profile && (
                <span className="font-mono text-[11px] text-normal">
                  {p.profile}
                </span>
              )}
              <span className="text-[11.5px] text-normal">
                {(p.kind === 'dev' || p.kind === 'review') &&
                  t('issues.plan.phases.round', { n: p.round })}
                {p.kind === 'merge' && t('issues.plan.phases.mergeSub')}
              </span>
              {p.steps.length > 0 && (
                <span className="mt-0.5 grid gap-[3px]">
                  {p.steps.map((s) => (
                    <span
                      key={s.n}
                      className="flex items-center gap-1.5 text-[11px] text-normal"
                    >
                      <i
                        className={cn(
                          'size-1.5 flex-none rounded-full',
                          STEP_DOT[s.state] ?? STEP_DOT.pending
                        )}
                      />
                      <span className="truncate">{s.title}</span>
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
