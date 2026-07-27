import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { cn } from '@/shared/lib/utils';
import type { IssueLabel, IssuePriority } from '@/features/issues/types';
import type { Worker } from '@/features/sprint/types';
import type { SprintFilters } from './SprintFilterBar';
import { PriorityBadge } from './PriorityBadge';

const PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

interface SprintSidebarProps {
  filters: SprintFilters;
  epics: string[];
  labels: IssueLabel[];
  workers: Worker[];
  onFiltersChange: (next: SprintFilters) => void;
}

function FilterRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex w-full items-center gap-2 h-[22px] pl-[22px] pr-2 text-left text-sm',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand',
        selected
          ? 'bg-sel text-high before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-[2px] before:bg-brand-on-surface'
          : 'text-normal hover:bg-secondary'
      )}
    >
      {children}
    </button>
  );
}

function SidebarSection({
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
    <CollapsibleSectionHeader
      persistKey={persistKey}
      title={title}
      count={count}
      defaultExpanded={defaultOpen}
    >
      <div className="flex flex-col">{children}</div>
    </CollapsibleSectionHeader>
  );
}

/**
 * Shell sidebar for the Sprint section (SHELL-SPEC R9): search plus
 * single-select filter sections, all driving the board's URL filter params.
 */
export function SprintSidebar({
  filters,
  epics,
  labels,
  workers,
  onFiltersChange,
}: SprintSidebarProps) {
  const { t } = useTranslation('common');

  const setFilter = useMemo(
    () =>
      <K extends keyof SprintFilters>(key: K, value: SprintFilters[K]) =>
        onFiltersChange({ ...filters, [key]: value }),
    [filters, onFiltersChange]
  );

  const toggle = <K extends keyof SprintFilters>(
    key: K,
    value: SprintFilters[K]
  ) => setFilter(key, filters[key] === value ? ('' as SprintFilters[K]) : value);

  return (
    <div className="flex h-full min-h-0 flex-col bg-md-surface-container-low border-r border-md-outline-variant">
      <div className="flex h-9 flex-none items-center px-3.5 text-label uppercase tracking-wider text-low">
        {t('sprint.title')}
      </div>
      <div className="mx-2.5 mb-2 flex h-[26px] flex-none items-center gap-1.5 rounded-md border border-border-strong bg-md-surface-container-lowest px-2">
        <Search size={13} strokeWidth={1.75} className="text-low" aria-hidden />
        <input
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          placeholder={t('sprint.filters.searchPlaceholder', {
            defaultValue: 'Filter issues…',
          })}
          className="w-full bg-transparent text-sm text-high placeholder:text-low focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {workers.length > 0 && (
          <SidebarSection
            persistKey="sprint-sidebar-workers"
            title={t('sprint.filters.worker', { defaultValue: 'Worker' })}
            count={workers.length}
          >
            {workers.map((worker) => (
              <FilterRow
                key={worker.id}
                selected={filters.worker === worker.id}
                onClick={() => toggle('worker', worker.id)}
              >
                <span className="truncate">{worker.name}</span>
              </FilterRow>
            ))}
          </SidebarSection>
        )}
        <SidebarSection
          persistKey="sprint-sidebar-priority"
          title={t('sprint.filters.priority', { defaultValue: 'Priority' })}
        >
          {PRIORITIES.map((priority) => (
            <FilterRow
              key={priority}
              selected={filters.priority === priority}
              onClick={() => toggle('priority', priority)}
            >
              <PriorityBadge priority={priority} />
            </FilterRow>
          ))}
        </SidebarSection>
        {labels.length > 0 && (
          <SidebarSection
            persistKey="sprint-sidebar-labels"
            title={t('sprint.filters.label', { defaultValue: 'Label' })}
            count={labels.length}
            defaultOpen={false}
          >
            {labels.map((label) => (
              <FilterRow
                key={label.name}
                selected={filters.label === label.name}
                onClick={() => toggle('label', label.name)}
              >
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ backgroundColor: `#${label.color}` }}
                  aria-hidden
                />
                <span className="truncate">{label.name}</span>
              </FilterRow>
            ))}
          </SidebarSection>
        )}
        {epics.length > 0 && (
          <SidebarSection
            persistKey="sprint-sidebar-epics"
            title={t('sprint.filters.epic', { defaultValue: 'Epic' })}
            count={epics.length}
            defaultOpen={false}
          >
            {epics.map((epic) => (
              <FilterRow
                key={epic}
                selected={filters.epic === epic}
                onClick={() => toggle('epic', epic)}
              >
                <span className="truncate">{epic}</span>
              </FilterRow>
            ))}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
