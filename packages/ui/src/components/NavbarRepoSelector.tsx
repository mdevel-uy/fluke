import { ChevronDown, FolderGit2 } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';

export interface NavbarRepoOption {
  id: string;
  label: string;
}

export interface NavbarRepoSelectorProps {
  repos: NavbarRepoOption[];
  selectedRepoId: string | null;
  onSelect: (repoId: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}

/**
 * Repo picker for the global navbar. Sized to match `CommandBarTrigger` (h-6,
 * pill) so the 36px bar keeps one control height.
 */
export function NavbarRepoSelector({
  repos,
  selectedRepoId,
  onSelect,
  placeholder,
  ariaLabel,
  className,
}: NavbarRepoSelectorProps) {
  const selected = repos.find((r) => r.id === selectedRepoId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={selected?.label ?? placeholder}
          disabled={repos.length === 0}
          className={cn(
            'group flex h-6 max-w-[220px] items-center gap-1.5 rounded-full border border-md-outline-variant px-2',
            'bg-md-surface-container-low text-md-on-surface-variant',
            'hover:border-md-outline hover:bg-md-surface-container hover:text-md-on-surface',
            'transition-colors duration-150 active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            'disabled:cursor-not-allowed disabled:opacity-40',
            className
          )}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate text-xs">
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        {repos.map((repo) => (
          <DropdownMenuCheckboxItem
            key={repo.id}
            checked={repo.id === selectedRepoId}
            onCheckedChange={() => onSelect(repo.id)}
          >
            <span className="truncate">{repo.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
