import { cn } from '@/shared/lib/utils';
import {
  METER_CRIT_RATIO,
  METER_WARN_RATIO,
} from '@/features/dashboard/model/dashboardMetrics';

export function SubDot({ tone }: { tone: 'success' | 'error' }) {
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'success' ? 'bg-success' : 'bg-error'
      )}
      aria-hidden
    />
  );
}

export function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: 'success' | 'warning' | 'error' | 'info' | 'muted';
  label: string;
  pulse?: boolean;
}) {
  const toneClasses = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
    info: 'bg-info/10 text-info',
    muted: 'bg-secondary text-low',
  } as const;
  const dotClasses = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    info: 'bg-info',
    muted: 'bg-md-outline',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        toneClasses[tone]
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          dotClasses[tone],
          pulse && 'animate-pulse motion-reduce:animate-none'
        )}
      />
      {label}
    </span>
  );
}

/** Uppercase 11px section label sitting above a grid (mock: `.section-title`). */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-sans text-label font-semibold uppercase tracking-wide text-low">
      {children}
    </h2>
  );
}

export function CountChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-secondary px-2 py-px text-xs font-semibold normal-case tracking-normal text-normal tabular-nums">
      {children}
    </span>
  );
}

/**
 * Card whose title lives inside it, above a hairline (mock: `.panel`).
 * `aside` is pushed to the right of the head.
 */
export function Panel({
  title,
  chip,
  aside,
  className,
  children,
}: {
  title: string;
  chip?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-border bg-card',
        className
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 font-sans text-label font-semibold uppercase tracking-wide text-low">
        {title}
        {chip !== undefined && <CountChip>{chip}</CountChip>}
        {aside !== undefined && (
          <span className="ml-auto text-xs font-normal normal-case tracking-normal text-low">
            {aside}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-4 text-sm text-low">{children}</p>;
}

export function meterTone(
  ratio: number | null
): 'muted' | 'success' | 'warning' | 'error' {
  if (ratio === null) return 'muted';
  if (ratio >= METER_CRIT_RATIO) return 'error';
  if (ratio >= METER_WARN_RATIO) return 'warning';
  return 'success';
}

const METER_FILL_CLASS = {
  muted: 'bg-md-outline',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
} as const;

/** Context usage and Claude plan meters share this bar and its thresholds. */
export function MeterBar({
  ratio,
  label,
}: {
  ratio: number | null;
  label?: string;
}) {
  const pct = ratio === null ? 0 : Math.round(Math.min(1, ratio) * 100);
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-md-outline-variant/60"
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <div
        className={cn(
          'h-full rounded-full',
          METER_FILL_CLASS[meterTone(ratio)]
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
