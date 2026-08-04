import { ResizableSidebarSection } from '@vibe/ui/components/ResizableSidebarSection';
import { cn } from '@/shared/lib/utils';

/** 22px single-select row for shell sidebar filter/nav lists (SHELL-SPEC R11). */
export function SidebarRow({
  selected = false,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // VSCode-style inset rows: side gutter + rounded hover/selection
        'relative flex items-center gap-2 h-[22px] mx-1.5 pl-4 pr-2 rounded-[4px] text-left text-sm',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        selected
          ? 'bg-sel text-high before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-[2px] before:rounded-full before:bg-brand-on-surface'
          : 'text-normal hover:bg-secondary'
      )}
    >
      {children}
    </button>
  );
}

/**
 * Collapsible section wrapper with persisted expanded state. The bottom
 * hairline doubles as a vertical resize handle when the section is open
 * (VSCode sidebar sections).
 */
export function SidebarSection({
  persistKey,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  persistKey: string;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ResizableSidebarSection
      persistKey={persistKey}
      title={title}
      count={count}
      defaultOpen={defaultOpen}
    >
      <div className="flex flex-col">{children}</div>
    </ResizableSidebarSection>
  );
}

// The repository picker that used to live here (SidebarRepoSection) was
// removed: the status bar owns repo/project selection (SHELL-SPEC R25).
