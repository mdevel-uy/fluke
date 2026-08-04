import { useCallback, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';

// VSCode's "Views and More Actions" (⋯) on the sidebar title: a checkbox
// menu to show/hide the panel's sections. Hidden state persists per sidebar.

const HIDDEN_KEY_PREFIX = 'vibe.ui.hidden-sections.';

function loadHidden(sidebarKey: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(`${HIDDEN_KEY_PREFIX}${sidebarKey}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Per-sidebar hidden-section record, persisted to localStorage. */
export function useHiddenSections(
  sidebarKey: string
): [Record<string, boolean>, (sectionKey: string) => void] {
  const [hidden, setHidden] = useState<Record<string, boolean>>(() =>
    loadHidden(sidebarKey)
  );
  const toggle = useCallback(
    (sectionKey: string) => {
      setHidden((prev) => {
        const next = { ...prev, [sectionKey]: !prev[sectionKey] };
        try {
          window.localStorage.setItem(
            `${HIDDEN_KEY_PREFIX}${sidebarKey}`,
            JSON.stringify(next)
          );
        } catch {
          // localStorage may be unavailable
        }
        return next;
      });
    },
    [sidebarKey]
  );
  return [hidden, toggle];
}

export interface SidebarSectionsMenuProps {
  sections: { key: string; label: string }[];
  hidden: Record<string, boolean>;
  onToggle: (sectionKey: string) => void;
}

export function SidebarSectionsMenu({
  sections,
  hidden,
  onToggle,
}: SidebarSectionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Show or hide sections"
        className="flex h-5 w-5 items-center justify-center rounded-sm text-md-on-surface-variant hover:bg-md-surface-container hover:text-md-on-surface cursor-pointer focus:outline-none"
      >
        <Ellipsis size={14} strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="min-w-[180px]">
        {sections.map((section) => (
          <DropdownMenuCheckboxItem
            key={section.key}
            checked={!hidden[section.key]}
            onCheckedChange={() => onToggle(section.key)}
            onSelect={(e) => e.preventDefault()}
          >
            {section.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
