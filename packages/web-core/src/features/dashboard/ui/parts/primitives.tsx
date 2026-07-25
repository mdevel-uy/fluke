import { cn } from '@/shared/lib/utils';

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
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
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

export function SectionTitle({
  children,
  chip,
}: {
  children: React.ReactNode;
  chip?: React.ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2 font-sans text-label font-semibold uppercase tracking-wide text-low">
      {children}
      {chip !== undefined && (
        <span className="rounded-full bg-secondary px-2 py-px text-[10px] font-semibold normal-case tracking-normal text-normal tabular-nums">
          {chip}
        </span>
      )}
    </h2>
  );
}
