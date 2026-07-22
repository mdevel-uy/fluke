import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlassIcon,
  XIcon,
  FunnelSimpleIcon,
} from '@phosphor-icons/react';
import { cn } from '@/shared/lib/utils';
import type { IssuePriority, IssueLabel } from '@/features/issues/types';
import type { Worker } from '@/features/sprint/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { PriorityBadge } from './PriorityBadge';
import { IssueLabelChip } from './IssueLabelChip';

export interface SprintFilters {
  q: string;
  epic: string;
  label: string;
  priority: IssuePriority | '';
  worker: string;
}

interface SprintFilterBarProps {
  filters: SprintFilters;
  epics: string[];
  labels: IssueLabel[];
  workers: Worker[];
  onFiltersChange: (next: SprintFilters) => void;
}

const PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

export function SprintFilterBar({
  filters,
  epics,
  labels,
  workers,
  onFiltersChange,
}: SprintFilterBarProps) {
  const { t } = useTranslation('common');
  const [searchInput, setSearchInput] = useState(filters.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external filter.q changes into local input
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onFiltersChange({ ...filters, q: value });
      }, 250);
    },
    [filters, onFiltersChange]
  );

  const setFilter = useCallback(
    <K extends keyof SprintFilters>(key: K, value: SprintFilters[K]) => {
      onFiltersChange({ ...filters, [key]: value });
    },
    [filters, onFiltersChange]
  );

  const clearAll = useCallback(() => {
    setSearchInput('');
    onFiltersChange({ q: '', epic: '', label: '', priority: '', worker: '' });
  }, [onFiltersChange]);

  const hasActiveFilters =
    filters.q ||
    filters.epic ||
    filters.label ||
    filters.priority ||
    filters.worker;

  const selectedWorker = workers.find((w) => w.id === filters.worker);
  const selectedLabel = labels.find((l) => l.name === filters.label);

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60 bg-primary/50 flex-wrap">
      <FunnelSimpleIcon className="size-4 text-low shrink-0" />

      {/* Text search */}
      <div className="relative flex-1 min-w-[160px] max-w-[280px]">
        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-low pointer-events-none" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={t('sprint.filters.searchPlaceholder')}
          className={cn(
            'w-full h-7 pl-7 pr-2.5 rounded-lg border border-border/60',
            'bg-primary text-sm text-high placeholder:text-low',
            'focus:outline-none focus:ring-1 focus:ring-brand/40 focus:border-brand/50',
            'transition-colors'
          )}
        />
        {searchInput && (
          <button
            onClick={() => handleSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-low hover:text-high transition-colors"
            aria-label={t('sprint.filters.clearSearch')}
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>

      {/* Epic filter */}
      {epics.length > 0 && (
        <FilterDropdown
          label={filters.epic || t('sprint.filters.epic')}
          active={!!filters.epic}
        >
          <DropdownMenuItem onSelect={() => setFilter('epic', '')}>
            <span className="text-low">{t('sprint.filters.allEpics')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {epics.map((epic) => (
            <DropdownMenuItem
              key={epic}
              onSelect={() => setFilter('epic', epic)}
              className={filters.epic === epic ? 'bg-secondary' : ''}
            >
              <span className="mr-1.5 text-[10px]">◎</span>
              {epic}
            </DropdownMenuItem>
          ))}
        </FilterDropdown>
      )}

      {/* Label filter */}
      {labels.length > 0 && (
        <FilterDropdown
          label={
            selectedLabel ? (
              <IssueLabelChip label={selectedLabel} />
            ) : (
              t('sprint.filters.label')
            )
          }
          active={!!filters.label}
        >
          <DropdownMenuItem onSelect={() => setFilter('label', '')}>
            <span className="text-low">{t('sprint.filters.allLabels')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {labels.map((lbl) => (
            <DropdownMenuItem
              key={lbl.name}
              onSelect={() => setFilter('label', lbl.name)}
              className={filters.label === lbl.name ? 'bg-secondary' : ''}
            >
              <IssueLabelChip label={lbl} />
            </DropdownMenuItem>
          ))}
        </FilterDropdown>
      )}

      {/* Priority filter */}
      <FilterDropdown
        label={
          filters.priority ? (
            <PriorityBadge priority={filters.priority} showLabel />
          ) : (
            t('sprint.filters.priority')
          )
        }
        active={!!filters.priority}
      >
        <DropdownMenuItem onSelect={() => setFilter('priority', '')}>
          <span className="text-low">{t('sprint.filters.allPriorities')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {PRIORITIES.map((p) => (
          <DropdownMenuItem
            key={p}
            onSelect={() => setFilter('priority', p)}
            className={filters.priority === p ? 'bg-secondary' : ''}
          >
            <PriorityBadge priority={p} showLabel />
          </DropdownMenuItem>
        ))}
      </FilterDropdown>

      {/* Worker filter */}
      {workers.length > 0 && (
        <FilterDropdown
          label={
            selectedWorker ? selectedWorker.name : t('sprint.filters.worker')
          }
          active={!!filters.worker}
        >
          <DropdownMenuItem onSelect={() => setFilter('worker', '')}>
            <span className="text-low">{t('sprint.filters.allWorkers')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {workers.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => setFilter('worker', w.id)}
              className={filters.worker === w.id ? 'bg-secondary' : ''}
            >
              {w.name}
            </DropdownMenuItem>
          ))}
        </FilterDropdown>
      )}

      {/* Clear all */}
      {hasActiveFilters && (
        <button
          onClick={clearAll}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-lg text-xs text-low hover:text-high hover:bg-secondary border border-transparent hover:border-border/50 transition-all"
        >
          <XIcon className="size-3" />
          {t('sprint.filters.clearAll')}
        </button>
      )}
    </div>
  );
}

interface FilterDropdownProps {
  label: React.ReactNode;
  active: boolean;
  children: React.ReactNode;
}

function FilterDropdown({ label, active, children }: FilterDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium border transition-all',
            'focus:outline-none focus:ring-1 focus:ring-brand/40',
            active
              ? 'bg-brand/10 border-brand/30 text-brand-on-surface'
              : 'bg-primary border-border/60 text-low hover:text-high hover:border-border hover:bg-secondary'
          )}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
