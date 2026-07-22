import { useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

/* Workbench chrome primitives — 1:1 port of the approved design-system
   mockup (design/UI-SPEC.md, artifact "Workbench"). Pure presentation. */

/* ── Activity rail ─────────────────────────────────────────────── */

export function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-14 flex-none flex-col items-center gap-0.5 overflow-y-auto border-r border-md-outline-variant bg-md-surface-container-lowest py-1.5">
      {children}
    </div>
  );
}

export function RailSpacer() {
  return <span className="flex-1" aria-hidden />;
}

interface RailButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  isActive?: boolean;
  badge?: number;
  children: ReactNode;
}

export function RailButton({
  label,
  isActive = false,
  badge,
  className,
  children,
  ...props
}: RailButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'relative flex h-10 w-10 flex-none items-center justify-center rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        isActive
          ? 'text-md-on-surface before:absolute before:-left-2 before:bottom-2 before:top-2 before:w-[2px] before:bg-brand-on-surface'
          : 'text-md-outline hover:text-md-on-surface',
        className
      )}
      {...props}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="absolute bottom-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-none text-on-brand tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

/* ── Side panel + tree ─────────────────────────────────────────── */

export function SidePanel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-md-surface-container-lowest">
      <div className="flex h-9 flex-none items-center justify-between pl-4 pr-2">
        <span className="truncate text-label font-semibold uppercase tracking-wider text-normal">
          {title}
        </span>
        {actions && (
          <span className="flex items-center gap-0.5">{actions}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function PanelIconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'flex h-[22px] w-[22px] items-center justify-center rounded-sm text-md-on-surface-variant transition-colors duration-150 hover:bg-md-surface-container hover:text-md-on-surface',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TreeSection({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[22px] w-full select-none items-center gap-0.5 px-2 text-label font-semibold uppercase tracking-wider text-normal hover:text-high"
        aria-expanded={open}
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className={cn(
            'shrink-0 transition-transform duration-100',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        <span className="truncate">
          {title}
          {count !== undefined && (
            <span className="font-normal text-low tabular-nums">
              {' '}
              — {count}
            </span>
          )}
        </span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

export function TreeRow({
  selected = false,
  mono = false,
  meta,
  onClick,
  children,
}: {
  selected?: boolean;
  mono?: boolean;
  meta?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[22px] w-full cursor-pointer items-center gap-1.5 whitespace-nowrap pl-[22px] pr-2 text-left transition-colors duration-100',
        selected ? 'bg-sel text-high' : 'text-high hover:bg-secondary'
      )}
    >
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 truncate',
          mono && 'font-mono text-xs text-normal'
        )}
      >
        {children}
      </span>
      {meta && (
        <span className="flex-none text-label normal-case tracking-normal text-low tabular-nums">
          {meta}
        </span>
      )}
    </button>
  );
}

export function Dot({
  tone,
  pulse = false,
}: {
  tone: 'busy' | 'ok' | 'idle' | 'err' | 'warn';
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-[7px] w-[7px] flex-none rounded-full',
        tone === 'busy' && 'bg-brand',
        tone === 'ok' && 'bg-success',
        tone === 'idle' && 'bg-low',
        tone === 'err' && 'bg-error',
        tone === 'warn' && 'bg-warning',
        (pulse || tone === 'busy') && 'animate-pulse'
      )}
    />
  );
}

export function TreeEmpty({ children }: { children: ReactNode }) {
  return <p className="py-0.5 pl-[22px] pr-2 text-xs text-low">{children}</p>;
}
