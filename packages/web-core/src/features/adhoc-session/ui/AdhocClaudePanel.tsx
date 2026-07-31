import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useAdhocPanelStore } from '../model/useAdhocPanelStore';

// Global ad-hoc chat panel — right-anchored slide-in that overlays the main
// column without collapsing it (portal to document.body, fixed positioning).
// Structure only in this issue: no session/chat wiring yet — just the shell.

export function AdhocClaudePanel() {
  const { t } = useTranslation('common');
  const isOpen = useAdhocPanelStore((s) => s.isOpen);
  const close = useAdhocPanelStore((s) => s.close);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Focus management: move focus into the panel on open and return it to
  // the previously focused element (typically the toggle) on close so
  // keyboard users don't lose their place.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer to next frame so the panel is mounted before we focus it.
    const raf = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const target = previouslyFocusedRef.current;
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [isOpen]);

  // Escape closes the panel from anywhere (matches drawer conventions).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, close]);

  const panelLabel = t('adhocPanel.title', { defaultValue: 'Ad-hoc Claude' });
  const closeLabel = t('adhocPanel.close', {
    defaultValue: 'Close ad-hoc Claude panel',
  });

  return createPortal(
    <aside
      ref={panelRef}
      role="complementary"
      aria-label={panelLabel}
      aria-hidden={!isOpen}
      className={cn(
        'fixed right-0 top-0 h-full w-full max-w-[380px] z-[80]',
        'bg-primary border-l border-md-outline-variant shadow-overlay',
        'flex flex-col transition-transform duration-200 ease-out',
        isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
      )}
    >
      <div className="flex items-center justify-between gap-2 h-10 px-3 border-b border-md-outline-variant shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles
            className="h-4 w-4 text-brand-on-surface shrink-0"
            strokeWidth={1.75}
          />
          <span className="text-sm font-medium text-high truncate">
            {panelLabel}
          </span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          className="p-1 rounded-md text-low hover:text-high hover:bg-secondary/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          aria-label={closeLabel}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <AdhocClaudePanelPlaceholder />
      </div>
    </aside>,
    document.body
  );
}

function AdhocClaudePanelPlaceholder() {
  const { t } = useTranslation('common');
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary/60 text-brand-on-surface">
        <Sparkles className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium text-high">
        {t('adhocPanel.placeholder.title', {
          defaultValue: 'Ad-hoc Claude no disponible',
        })}
      </p>
      <p className="text-xs text-low max-w-[260px]">
        {t('adhocPanel.placeholder.description', {
          defaultValue:
            'Este panel es la estructura base; la sesión de Claude se integra en un paso siguiente.',
        })}
      </p>
    </div>
  );
}
