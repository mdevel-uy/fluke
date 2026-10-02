import { useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { cn } from '@/shared/lib/utils';

// SHELL-SPEC R18/R30: the shell owns the right aside panel (width, resize,
// visibility) so the terminal below the main column never spans under it.
// Pages contribute their aside content through this portal, mirroring the
// ShellSidebar pattern. A module store (the shell is a singleton) lets the
// layout know whether any page contributed content without re-nesting
// SharedAppLayout inside another provider.

interface ShellAsideState {
  targetEl: HTMLElement | null;
  contentCount: number;
  setTargetEl: (el: HTMLElement | null) => void;
  registerContent: () => () => void;
}

const useShellAsideStore = create<ShellAsideState>((set) => ({
  targetEl: null,
  contentCount: 0,
  setTargetEl: (el) => set({ targetEl: el }),
  registerContent: () => {
    set((s) => ({ contentCount: s.contentCount + 1 }));
    return () => set((s) => ({ contentCount: Math.max(0, s.contentCount - 1) }));
  },
}));

/** Whether any page is currently contributing aside content. */
export function useShellAsideHasContent(): boolean {
  return useShellAsideStore((s) => s.contentCount > 0);
}

/** Mount point rendered by the shell inside its aside panel. */
export function ShellAsideSlot({ className }: { className?: string }) {
  const setTargetEl = useShellAsideStore((s) => s.setTargetEl);
  const ref = useCallback(
    (el: HTMLElement | null) => setTargetEl(el),
    [setTargetEl]
  );
  return <div ref={ref} className={className} />;
}

/**
 * Rendered by a page to contribute its aside content into the shell slot.
 * Contributors can coexist (a page aside plus the pinned Fluke assistant):
 * each gets its own flex section of the slot, so none is pushed below the
 * clipped edge (issue #637). `className` lets a contributor fix its order.
 */
export function ShellAsidePortal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const targetEl = useShellAsideStore((s) => s.targetEl);
  const registerContent = useShellAsideStore((s) => s.registerContent);
  useEffect(() => registerContent(), [registerContent]);
  if (!targetEl) return null;
  return createPortal(
    <div className={cn('min-h-0 flex-1 overflow-hidden', className)}>
      {children}
    </div>,
    targetEl
  );
}
