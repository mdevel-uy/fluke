import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CheckIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';

export interface MissionTabEntry {
  id: string;
  label: string;
  attention: boolean;
  running: boolean;
  /** False for the guard mission, which has no X on its tab either. */
  closable: boolean;
}

/**
 * Overflow button of the mission tab bar (spec #648): `+N` hidden tabs, and
 * a menu with every open tab in bar order, so any tab is found in one place.
 */
export function MissionTabsMenu({
  entries,
  hiddenIds,
  activeId,
  onSelect,
  onDelete,
  deleteLabel,
}: {
  entries: MissionTabEntry[];
  hiddenIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** Label of the X for a tab, from its title. */
  deleteLabel: (label: string) => string;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const count = hiddenIds.length;
  const waiting = entries.filter(
    (e) => e.attention && hiddenIds.includes(e.id)
  ).length;
  const label = waiting
    ? t('director.openTabsWaiting', { count, waiting })
    : t('director.openTabs', { count });

  // Deleting asks for confirmation in a dialog, which sits under the menu:
  // close the menu first.
  const remove = (id: string) => {
    setOpen(false);
    onDelete(id);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="relative flex h-6 w-11 shrink-0 items-center justify-center gap-0.5 self-center rounded-md text-xs tabular-nums text-low hover:bg-secondary/60 hover:text-high focus:outline-none focus-visible:ring-1 focus-visible:ring-brand data-[state=open]:bg-secondary/60 data-[state=open]:text-high"
        >
          +{count}
          <CaretDownIcon className="size-icon-2xs" />
          {waiting > 0 && (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-[min(300px,calc(100vw-2rem))] overflow-y-auto"
      >
        {entries.map((e) => {
          const current = e.id === activeId;
          return (
            <DropdownMenuItem
              key={e.id}
              onSelect={() => onSelect(e.id)}
              onKeyDown={(ev) => {
                if (
                  e.closable &&
                  (ev.key === 'Delete' || ev.key === 'Backspace')
                ) {
                  ev.preventDefault();
                  remove(e.id);
                }
              }}
              className="gap-2 text-xs [&_svg]:size-icon-2xs"
            >
              <span className="flex w-3 shrink-0 text-brand">
                {current && <CheckIcon />}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  current && 'font-medium text-high'
                )}
                title={e.label}
              >
                {e.label}
              </span>
              {e.attention && (
                <span className="size-1.5 shrink-0 rounded-full bg-warning" />
              )}
              {e.running && <SpinnerIcon className="animate-spin text-low" />}
              {e.closable && (
                // Always visible: on touch it's the only way to close a
                // hidden tab. It must not select the item: Radix's MenuItem
                // clicks itself on a pointerup that had no pointerdown on
                // it, so all three events stop here.
                <button
                  type="button"
                  tabIndex={-1}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onPointerUp={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    remove(e.id);
                  }}
                  aria-label={deleteLabel(e.label)}
                  title={deleteLabel(e.label)}
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm text-low hover:bg-secondary/60 hover:text-high"
                >
                  <XIcon />
                </button>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
