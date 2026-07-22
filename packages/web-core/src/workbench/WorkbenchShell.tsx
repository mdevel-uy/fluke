import { useEffect, type ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

/* Workbench shell — the mockup's frame: activity rail · collapsible side
   panel (⌘B) · main column (top bar + content) · status bar. */

export function WorkbenchShell({
  rail,
  sidebar,
  topBar,
  statusBar,
  children,
}: {
  rail: ReactNode;
  sidebar: ReactNode;
  topBar: ReactNode;
  statusBar: ReactNode;
  children: ReactNode;
}) {
  const isSidebarVisible = useUiPreferencesStore((s) => s.isLeftSidebarVisible);
  const toggleLeftSidebar = useUiPreferencesStore((s) => s.toggleLeftSidebar);

  // ⌘B / Ctrl+B toggles the side panel, VSCode-style.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        toggleLeftSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleLeftSidebar]);

  return (
    <div className="flex h-screen flex-col bg-md-background">
      <div className="flex min-h-0 flex-1">
        {rail}
        <div
          className={cn(
            'w-60 flex-none overflow-hidden border-r border-md-outline-variant transition-[width] duration-150 ease-out',
            !isSidebarVisible && 'w-0 border-r-0'
          )}
          aria-hidden={!isSidebarVisible}
        >
          <div className="h-full w-60">{sidebar}</div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {topBar}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {children}
          </div>
        </div>
      </div>
      {statusBar}
    </div>
  );
}
