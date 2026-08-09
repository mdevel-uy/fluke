import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from './CollapsibleSectionHeader';

// VSCode-style sidebar section: the hairline under an expanded section is
// also a drag handle that resizes the section vertically; its content then
// scrolls within the fixed height. Height persists per persistKey.

const SIZE_KEY_PREFIX = 'vibe.ui.section-size.';
const MIN_BODY_HEIGHT = 44;

function loadHeight(persistKey?: string): number | null {
  if (!persistKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${SIZE_KEY_PREFIX}${persistKey}`);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= MIN_BODY_HEIGHT ? n : null;
  } catch {
    return null;
  }
}

function saveHeight(persistKey: string | undefined, height: number | null) {
  if (!persistKey || typeof window === 'undefined') return;
  try {
    if (height == null) {
      window.localStorage.removeItem(`${SIZE_KEY_PREFIX}${persistKey}`);
    } else {
      window.localStorage.setItem(
        `${SIZE_KEY_PREFIX}${persistKey}`,
        String(Math.round(height))
      );
    }
  } catch {
    // localStorage may be unavailable
  }
}

export interface ResizableSidebarSectionProps {
  persistKey?: string;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  actions?: SectionAction[];
  children: ReactNode;
}

export function ResizableSidebarSection({
  persistKey,
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: ResizableSidebarSectionProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [height, setHeight] = useState<number | null>(() =>
    loadHeight(persistKey)
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef<number | null>(height);
  heightRef.current = height;
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const measured = bodyRef.current?.offsetHeight ?? 0;
    dragRef.current = {
      startY: e.clientY,
      startHeight: heightRef.current ?? measured,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setHeight(
      Math.max(MIN_BODY_HEIGHT, drag.startHeight + (e.clientY - drag.startY))
    );
  }, []);

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      saveHeight(persistKey, heightRef.current);
    },
    [persistKey]
  );

  // Double click on the sash resets to natural height (VSCode-ish).
  const handleDoubleClick = useCallback(() => {
    setHeight(null);
    saveHeight(persistKey, null);
  }, [persistKey]);

  return (
    <div className="relative flex-none border-b last:border-b-0">
      <CollapsibleSectionHeader
        persistKey={persistKey}
        title={title}
        count={count}
        defaultExpanded={defaultOpen}
        actions={actions}
        onExpandedChange={setExpanded}
      >
        <div
          ref={bodyRef}
          className="min-h-0 overflow-y-auto"
          style={expanded && height != null ? { height } : undefined}
        >
          {children}
        </div>
      </CollapsibleSectionHeader>
      {expanded && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          className={cn(
            'absolute inset-x-0 -bottom-[3px] z-10 h-[6px] cursor-row-resize',
            'hover:bg-brand/40 active:bg-brand/60 transition-colors'
          )}
        />
      )}
    </div>
  );
}
