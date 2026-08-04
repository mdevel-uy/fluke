import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// SHELL-SPEC R9: each rail section contributes its own secondary sidebar.
// The shell owns the panel (width, resize, visibility); pages own the content
// and portal it in, so data/providers stay with the page that has them.

type ShellSidebarContextValue = {
  targetEl: HTMLElement | null;
  setTargetEl: (el: HTMLElement | null) => void;
};

const ShellSidebarContext = createContext<ShellSidebarContextValue | null>(
  null
);

export function ShellSidebarProvider({ children }: { children: ReactNode }) {
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ targetEl, setTargetEl }), [targetEl]);
  return (
    <ShellSidebarContext.Provider value={value}>
      {children}
    </ShellSidebarContext.Provider>
  );
}

/** Mount point rendered by the shell inside its sidebar panel. */
export function ShellSidebarSlot({ className }: { className?: string }) {
  const setTargetEl = useContext(ShellSidebarContext)?.setTargetEl;
  const ref = useCallback(
    (el: HTMLElement | null) => setTargetEl?.(el),
    [setTargetEl]
  );
  return <div ref={ref} className={className} />;
}

/** Rendered by a page to contribute its sidebar content into the shell slot. */
export function ShellSidebarPortal({ children }: { children: ReactNode }) {
  const targetEl = useContext(ShellSidebarContext)?.targetEl;
  if (!targetEl) return null;
  return createPortal(children, targetEl);
}
