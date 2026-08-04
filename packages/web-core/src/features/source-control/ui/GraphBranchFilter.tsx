import { useTranslation } from 'react-i18next';
import { ListFilter } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';

interface GraphBranchFilterProps {
  /** All local branch names (base excluded — it is always shown). */
  branchNames: string[];
  hidden: Set<string>;
  onChange: (hidden: Set<string>) => void;
}

/**
 * Tab-bar branch scope for the fleet graph (next to the BASE chip,
 * GitLens-style): checkbox per local branch; the base branch is always in.
 */
export function GraphBranchFilter({
  branchNames,
  hidden,
  onChange,
}: GraphBranchFilterProps) {
  const { t } = useTranslation('common');
  const shown = branchNames.length - hidden.size;
  const isFiltered = hidden.size > 0;

  const toggle = (name: string) => {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]',
            'cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
            isFiltered
              ? 'border-brand-on-surface/50 text-brand-on-surface'
              : 'border-border text-low hover:text-normal'
          )}
          title={t('sourceControl.branchFilter.tooltip', {
            defaultValue: 'Choose which branches the graph shows',
          })}
        >
          <ListFilter size={11} strokeWidth={2} />
          {t('sourceControl.branchFilter.label', {
            defaultValue: 'branches',
          })}{' '}
          {shown}/{branchNames.length}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onChange(new Set());
          }}
        >
          {t('sourceControl.branchFilter.showAll', {
            defaultValue: 'Show all',
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onChange(new Set(branchNames));
          }}
        >
          {t('sourceControl.branchFilter.hideAll', {
            defaultValue: 'Hide all',
          })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {branchNames.map((name) => (
          <DropdownMenuCheckboxItem
            key={name}
            checked={!hidden.has(name)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => toggle(name)}
            className="font-mono text-code"
          >
            <span className="min-w-0 truncate">{name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
