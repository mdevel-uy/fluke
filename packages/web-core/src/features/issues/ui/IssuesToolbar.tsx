import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterBar, type FilterBarFilter } from '@vibe/ui/components/FilterBar';
import type { IssueLabel } from 'shared/types';

export type IssueTaskStatusFilter = 'queued' | 'in_progress' | 'in_review';
export type IssueStateFilter =
  | 'all'
  | 'open'
  | 'closed'
  | IssueTaskStatusFilter;
export type IssuePriorityFilter = 'urgent' | 'high' | 'medium' | 'low';
export type IssueGroupBy = 'none' | 'label' | 'milestone';

export interface IssueFilters {
  search: string;
  state: IssueStateFilter;
  priorities: IssuePriorityFilter[];
  labels: string[];
  milestones: string[];
  workers: string[];
  groupBy: IssueGroupBy;
}

export const DEFAULT_FILTERS: IssueFilters = {
  search: '',
  state: 'open',
  priorities: [],
  labels: [],
  milestones: [],
  workers: [],
  groupBy: 'none',
};

export interface IssueWorkerOption {
  id: string;
  name: string;
}

interface IssuesToolbarProps {
  filters: IssueFilters;
  availableLabels: IssueLabel[];
  availableMilestones: string[];
  availableWorkers: IssueWorkerOption[];
  onChange: (filters: IssueFilters) => void;
}

const ISSUE_STATES: IssueStateFilter[] = ['all', 'open', 'closed'];
const TASK_STATUSES: IssueTaskStatusFilter[] = [
  'queued',
  'in_progress',
  'in_review',
];
const PRIORITIES: IssuePriorityFilter[] = ['urgent', 'high', 'medium', 'low'];
const GROUP_BY_OPTIONS: IssueGroupBy[] = ['none', 'label', 'milestone'];

/** Maps the issue list's filters onto the shared `FilterBar`. */
export function IssuesToolbar({
  filters,
  availableLabels,
  availableMilestones,
  availableWorkers,
  onChange,
}: IssuesToolbarProps) {
  const { t } = useTranslation('common');

  const stateLabel = (s: IssueStateFilter) =>
    (TASK_STATUSES as string[]).includes(s)
      ? t(`issues.taskStatus.${s}`)
      : t(`issues.filters.state.${s}`);

  const filterDefs = useMemo<FilterBarFilter[]>(
    () => [
      {
        id: 'state',
        label: t('issues.filters.stateLabel'),
        mode: 'single',
        triggerDisplay: 'selection',
        // 'open' is the default view, so it doesn't count as an active filter.
        active: filters.state !== 'open',
        menuLabel: null,
        menuClassName: 'w-40',
        selected: [filters.state],
        options: [
          ...ISSUE_STATES.map((s) => ({ value: s, label: stateLabel(s) })),
          ...TASK_STATUSES.map((s, i) => ({
            value: s,
            label: stateLabel(s),
            separatorBefore: i === 0,
          })),
        ],
        onChange: (next) =>
          onChange({
            ...filters,
            state: (next[0] as IssueStateFilter) ?? 'all',
          }),
      },
      {
        id: 'priority',
        label: t('issues.filters.priority'),
        menuClassName: 'w-44',
        selected: filters.priorities,
        options: PRIORITIES.map((p) => ({
          value: p,
          label: t(`issues.filters.priorities.${p}`),
        })),
        onChange: (next) =>
          onChange({ ...filters, priorities: next as IssuePriorityFilter[] }),
      },
      {
        id: 'label',
        label: t('issues.filters.label'),
        hidden: availableLabels.length === 0,
        selected: filters.labels,
        options: availableLabels.map((lbl) => ({
          value: lbl.name,
          label: lbl.name,
          color: lbl.color,
        })),
        onChange: (next) => onChange({ ...filters, labels: next }),
      },
      {
        id: 'milestone',
        label: t('issues.filters.milestone'),
        hidden: availableMilestones.length === 0,
        selected: filters.milestones,
        options: availableMilestones.map((m) => ({ value: m, label: m })),
        onChange: (next) => onChange({ ...filters, milestones: next }),
      },
      {
        id: 'worker',
        label: t('issues.filters.worker'),
        hidden: availableWorkers.length === 0,
        selected: filters.workers,
        options: availableWorkers.map((w) => ({ value: w.id, label: w.name })),
        onChange: (next) => onChange({ ...filters, workers: next }),
      },
      {
        id: 'groupBy',
        label: t('issues.filters.groupBy'),
        mode: 'single',
        triggerDisplay: 'append',
        active: filters.groupBy !== 'none',
        menuClassName: 'w-44',
        selected: filters.groupBy === 'none' ? [] : [filters.groupBy],
        options: GROUP_BY_OPTIONS.map((g) => ({
          value: g,
          label: t(`issues.filters.groupByOptions.${g}`),
        })),
        onChange: (next) =>
          onChange({
            ...filters,
            groupBy: (next[0] as IssueGroupBy) ?? 'none',
          }),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      t,
      filters,
      availableLabels,
      availableMilestones,
      availableWorkers,
      onChange,
    ]
  );

  const hasActiveFilters =
    filters.search !== '' ||
    filters.state !== 'open' ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.milestones.length > 0 ||
    filters.workers.length > 0;

  return (
    <FilterBar
      search={{
        value: filters.search,
        onChange: (search) => onChange({ ...filters, search }),
        placeholder: t('issues.filters.searchPlaceholder'),
        clearLabel: t('issues.filters.clearSearch'),
      }}
      filters={filterDefs}
      hasActiveFilters={hasActiveFilters}
      onClearAll={() => onChange(DEFAULT_FILTERS)}
      clearAllLabel={t('issues.filters.clear')}
    />
  );
}
