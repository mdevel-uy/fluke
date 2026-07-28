import * as React from 'react';
import { cn } from '../lib/cn';

export interface PageHeaderProps {
  /** Page title. Rendered as the page's single `h1`. */
  title: React.ReactNode;
  /** Chips or status indicators shown right after the title (e.g. LiveChip). */
  meta?: React.ReactNode;
  /**
   * Right-aligned controls. Keep the canonical order:
   * secondary action → toggles → primary CTA.
   * Every control should be 32px tall (`h-8`) so the row reads as one band.
   */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The 64px top bar every page shares. Owns the container styling so pages only
 * declare content — see `PageHeaderToggle` for the label+switch pattern.
 */
export function PageHeader({
  title,
  meta,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-16 shrink-0 items-center gap-3 border-b border-md-outline-variant bg-md-surface-bright px-container-padding',
        className
      )}
    >
      <h1 className="shrink-0 font-sans text-heading text-high">{title}</h1>
      {meta}
      {actions && (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

export interface PageHeaderToggleProps {
  label: string;
  title?: string;
  children: React.ReactNode;
}

/** Label + control pairing used for header switches, so every page matches. */
export function PageHeaderToggle({
  label,
  title,
  children,
}: PageHeaderToggleProps) {
  return (
    <label
      className="flex h-8 cursor-pointer select-none items-center gap-2 text-sm text-normal"
      title={title}
    >
      {children}
      <span>{label}</span>
    </label>
  );
}
