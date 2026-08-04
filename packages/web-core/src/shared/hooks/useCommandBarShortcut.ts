import { useEffect, useCallback } from 'react';

/**
 * Hook that listens for CMD+K (Mac) or Ctrl+K (Windows/Linux) to open the command bar,
 * and CMD+P / Ctrl+P for VSCode-style "Go to Page" Quick Open.
 * Uses native DOM event listener with capture phase to intercept before other handlers
 * like Lexical editor.
 *
 * Cmd+K → calls `onOpen()` (existing behavior, caller decides what to show).
 * Cmd+P → opens the CommandBar directly on the `goToPage` view, but only when
 *         no native text input is focused (otherwise browser default — Print — runs).
 */
export function useCommandBarShortcut(
  onOpen: () => void,
  enabled: boolean = true
) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // CMD (Mac) or Ctrl (Windows/Linux)
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier) return;

      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
        return;
      }

      if (key === 'p') {
        // Only hijack Cmd+P when no native text input is focused, so users can
        // still print from within forms/editors. This keeps preventDefault local.
        const target = event.target as HTMLElement | null;
        const isTextInput =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (isTextInput) return;

        event.preventDefault();
        event.stopPropagation();

        // Dynamic import both avoids any circular-dep surprises and keeps this
        // hook decoupled from the CommandBar bundle. Errors are swallowed so a
        // broken quick-open never breaks the user's flow.
        void import('@/shared/dialogs/command-bar/CommandBarDialog')
          .then(({ CommandBarDialog }) =>
            CommandBarDialog.show({ page: 'goToPage' })
          )
          .catch(() => {
            // silent — see sad path in issue #186
          });
      }
    },
    [onOpen]
  );

  useEffect(() => {
    if (!enabled) return;

    // Use capture phase to intercept before other handlers (like Lexical editor)
    window.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [handleKeyDown, enabled]);
}
