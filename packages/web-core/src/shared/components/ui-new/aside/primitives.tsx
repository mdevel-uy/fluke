import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from '@vibe/ui/components/CollapsibleSectionHeader';
import type { PersistKey } from '@/shared/stores/useUiPreferencesStore';

// SHELL-SPEC R18-R24 aside primitives, matching the approved mock
// (design/workbench-shell-mock.html): kv rows, semantic dots, ghost buttons
// and collapsible sections.

export type DotTone = 'ok' | 'err' | 'warn' | 'run' | 'idle';

const DOT_CLASS: Record<DotTone, string> = {
  ok: 'bg-success',
  err: 'bg-error',
  warn: 'bg-warning',
  run: 'bg-brand-on-surface animate-pulse',
  idle: 'bg-border-strong',
};

export function StatusDot({
  tone,
  className,
}: {
  tone: DotTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'h-[7px] w-[7px] flex-none rounded-full',
        DOT_CLASS[tone],
        className
      )}
      aria-hidden
    />
  );
}

export function Kv({
  k,
  v,
  mono = false,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2.5 px-3.5 py-[3px] text-sm">
      <span className="flex-none text-low">{k}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-high',
          mono && 'font-mono text-[12px]'
        )}
      >
        {v}
      </span>
    </div>
  );
}

export function GhostButton({
  onClick,
  disabled = false,
  children,
  className,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border border-border-strong px-2 text-[11px] text-normal',
        'hover:bg-secondary hover:text-high cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        className
      )}
    >
      {children}
    </button>
  );
}

export function AsideSection({
  persistKey,
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  persistKey: PersistKey;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  actions?: SectionAction[];
  children: ReactNode;
}) {
  // flex-none wrapper is mandatory: CollapsibleSectionHeader's root is
  // h-full flex-col and stretches inside definite-height containers.
  // VSCode-style: sections divided by a bottom hairline, except the last.
  return (
    <div className="flex-none border-b border-border last:border-b-0">
      <CollapsibleSectionHeader
        persistKey={persistKey}
        title={title}
        count={count}
        defaultExpanded={defaultOpen}
        actions={actions}
      >
        <div className="pb-2">{children}</div>
      </CollapsibleSectionHeader>
    </div>
  );
}

/** Compact duration since a timestamp: 45s, 12m, 3h, 2d */
export function formatElapsed(iso?: string): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return '';
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
