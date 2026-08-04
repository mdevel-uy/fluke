import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';
import { getModifierKey } from '../lib/platform';

interface TooltipProps {
  children: ReactNode;
  content: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export function Tooltip({
  children,
  content,
  shortcut,
  side = 'bottom',
  className,
}: TooltipProps) {
  const formattedShortcut = shortcut?.replace('{mod}', getModifierKey());

  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              'z-[10000] flex items-center rounded-lg border border-border/60 bg-primary px-2.5 py-1.5 text-xs text-normal shadow-overlay',
              'animate-in fade-in-0 zoom-in-95',
              className
            )}
          >
            <span>{content}</span>
            {formattedShortcut && (
              <kbd
                className={cn(
                  'ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5',
                  'rounded-md border border-border/70 bg-secondary',
                  'font-ibm-plex-mono text-xs text-high'
                )}
              >
                {formattedShortcut}
              </kbd>
            )}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
