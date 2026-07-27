import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterBar, type FilterBarFilter } from '@vibe/ui/components/FilterBar';
import type { IssuePriority, IssueLabel } from '@/features/issues/types';
import type { Worker } from '@/features/sprint/types';
import { PriorityBadge } from './PriorityBadge';

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

const EMPTY_FILTERS: SprintFilters = {
  q: '',
  epic: '',
  label: '',
  priority: '',
  worker: '',
};

/**
 * Adapts the board's single-select filters onto the shared `FilterBar`, so
 * Kanban and Issues present search and filters identically.
 */
export function SprintFilterBar({
  filters,
  epics,
  labels,
  workers,
  onFiltersChange,
}: SprintFilterBarProps) {
  const { t } = useTranslation('common');

  const setFilter = useCallback(
    <K extends keyof SprintFilters>(key: K, value: SprintFilters[K]) => {
      onFiltersChange({ ...filters, [key]: value });
    },
    [filters, onFiltersChange]
  );

  // Every board filter holds at most one value; `[0] ?? ''` unwraps FilterBar's
  // array contract back onto that.
  const filterDefs = useMemo<FilterBarFilter[]>(
    () => [
      {
        id: 'epic',
        label: t('sprint.filters.epic'),
        mode: 'single',
        triggerDisplay: 'selection',
        hidden: epics.length === 0,
        clearOptionLabel: t('sprint.filters.allEpics'),
        menuLabel: null,
        menuClassName: 'min-w-[160px]',
        selected: filters.epic ? [filters.epic] : [],
        options: epics.map((epic) => ({ value: epic, label: epic })),
        onChange: (next) => setFilter('epic', next[0] ?? ''),
      },
      {
        id: 'label',
        label: t('sprint.filters.label'),
        mode: 'single',
        triggerDisplay: 'selection',
        hidden: labels.length === 0,
        clearOptionLabel: t('sprint.filters.allLabels'),
        menuLabel: null,
        selected: filters.label ? [filters.label] : [],
        options: labels.map((lbl) => ({
          value: lbl.name,
          label: lbl.name,
          color: lbl.color,
        })),
        onChange: (next) => setFilter('label', next[0] ?? ''),
      },
      {
        id: 'priority',
        label: t('sprint.filters.priority'),
        mode: 'single',
        triggerDisplay: 'selection',
        clearOptionLabel: t('sprint.filters.allPriorities'),
        menuLabel: null,
        menuClassName: 'min-w-[160px]',
        selected: filters.priority ? [filters.priority] : [],
        options: PRIORITIES.map((p) => ({
          value: p,
          label: <PriorityBadge priority={p} showLabel />,
        })),
        onChange: (next) =>
          setFilter('priority', (next[0] as IssuePriority) ?? ''),
      },
      {
        id: 'worker',
        label: t('sprint.filters.worker'),
        mode: 'single',
        triggerDisplay: 'selection',
        hidden: workers.length === 0,
        clearOptionLabel: t('sprint.filters.allWorkers'),
        menuLabel: null,
        selected: filters.worker ? [filters.worker] : [],
        options: workers.map((w) => ({ value: w.id, label: w.name })),
        onChange: (next) => setFilter('worker', next[0] ?? ''),
      },
    ],
    [t, epics, labels, workers, filters, setFilter]
  );

  return (
    <FilterBar
      search={{
        value: filters.q,
        onChange: (q) => setFilter('q', q),
        placeholder: t('sprint.filters.searchPlaceholder'),
        clearLabel: t('sprint.filters.clearSearch'),
        debounceMs: 250,
      }}
      filters={filterDefs}
      onClearAll={() => onFiltersChange(EMPTY_FILTERS)}
      clearAllLabel={t('sprint.filters.clearAll')}
    />
  );
}
