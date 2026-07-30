import { useEffect, useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useAdhocSessionStore } from '../model/useAdhocSessionStore';

// Ad-hoc Claude panel shell — issue #300. Structure only: no chat wiring yet.
// Rendered as a right-side overlay drawer that never resizes the main column
// (unlike ShellAside, which owns a Panel slot in the resizable group). This
// keeps it globally accessible without pushing page content around.
export function AdhocClaudePanel() {
  const isOpen = useAdhocSessionStore((s) => s.isOpen);
  const close = useAdhocSessionStore((s) => s.close);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // Preserve who opened the panel so focus returns there on close, not to the
  // document body (which would strand keyboard users).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen, close]);

  return (
    <div
      role="complementary"
      aria-label="Ad-hoc Claude panel"
      aria-hidden={!isOpen}
      className={cn(
        'fixed right-0 top-0 z-40 flex h-full w-[360px] max-w-[85vw] flex-col',
        'border-l border-md-outline-variant bg-md-surface-container-low shadow-2xl',
        'transition-transform duration-200 ease-out',
        isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 h-10 border-b border-md-outline-variant">
        <div className="flex items-center gap-2 text-sm font-medium text-high">
          <Sparkles size={16} strokeWidth={1.75} />
          <span>Ask Claude</span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          aria-label="Close ad-hoc Claude panel"
          className={cn(
            'p-1 rounded-sm text-low hover:bg-secondary hover:text-high transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand cursor-pointer'
          )}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        <AdhocPanelPlaceholder />
      </div>
    </div>
  );
}

function AdhocPanelPlaceholder() {
  return (
    <div className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-md-surface-container-high text-md-on-surface-variant">
        <Sparkles size={20} strokeWidth={1.5} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-high">No session yet</p>
        <p className="text-xs text-low leading-relaxed">
          Start a conversation with your configured model. Chat wiring lands in
          a follow-up — this shell keeps the panel reachable from anywhere.
        </p>
      </div>
    </div>
  );
}
