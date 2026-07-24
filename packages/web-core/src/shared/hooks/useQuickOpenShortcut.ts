import { useEffect, useCallback } from 'react';

function isNativeTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    const textLike = new Set([
      'text',
      'search',
      'email',
      'url',
      'tel',
      'password',
      'number',
    ]);
    return textLike.has(type);
  }
  return false;
}

/**
 * Hook that listens for CMD+P (Mac) or Ctrl+P (Windows/Linux) to open the
 * Quick Open page navigator. Falls through to the browser's Print shortcut
 * when a native text input has focus, so typing is never interrupted.
 */
export function useQuickOpenShortcut(
  onOpen: () => void,
  enabled: boolean = true
) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;

      if (!modifier || event.key.toLowerCase() !== 'p') return;
      if (event.shiftKey || event.altKey) return;
      if (isNativeTextInputFocused()) return;

      event.preventDefault();
      event.stopPropagation();
      onOpen();
    },
    [onOpen]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [handleKeyDown, enabled]);
}
