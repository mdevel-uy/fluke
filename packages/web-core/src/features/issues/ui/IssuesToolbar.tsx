import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search, X } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
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

export function IssuesToolbar({
  filters,
  availableLabels,
  availableMilestones,
  availableWorkers,
  onChange,
}: IssuesToolbarProps) {
  const { t } = useTranslation('common');
  const [localSearch, setLocalSearch] = useState(filters.search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external changes to local search
  useEffect(() => {
    setLocalSearch(filters.search);
  }, [filters.search]);

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange({ ...filters, search: value });
    }, 200);
  };

  const hasActiveFilters =
    filters.search !== '' ||
    filters.state !== 'open' ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0 ||
    filters.milestones.length > 0 ||
    filters.workers.length > 0;

  const clearFilters = () => {
    setLocalSearch('');
    onChange(DEFAULT_FILTERS);
  };

  const togglePriority = (p: IssuePriorityFilter) => {
    const next = filters.priorities.includes(p)
      ? filters.priorities.filter((x) => x !== p)
      : [...filters.priorities, p];
    onChange({ ...filters, priorities: next });
  };

  const toggleLabel = (name: string) => {
    const next = filters.labels.includes(name)
      ? filters.labels.filter((x) => x !== name)
      : [...filters.labels, name];
    onChange({ ...filters, labels: next });
  };

  const toggleMilestone = (m: string) => {
    const next = filters.milestones.includes(m)
      ? filters.milestones.filter((x) => x !== m)
      : [...filters.milestones, m];
    onChange({ ...filters, milestones: next });
  };

  const toggleWorker = (id: string) => {
    const next = filters.workers.includes(id)
      ? filters.workers.filter((x) => x !== id)
      : [...filters.workers, id];
    onChange({ ...filters, workers: next });
  };

  const stateLabel = (s: IssueStateFilter) =>
    (TASK_STATUSES as string[]).includes(s)
      ? t(`issues.taskStatus.${s}`)
      : t(`issues.filters.state.${s}`);

  return (
    <div className="flex items-center gap-2 px-6 py-3 border-b border-border/60 bg-primary flex-wrap">
      {/* Search */}
      <div className="relative flex-1 min-w-[180px] max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-low pointer-events-none" />
        <Input
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={t('issues.filters.searchPlaceholder')}
          className="pl-8 h-8 text-sm"
        />
      </div>

      {/* State filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={filters.state !== 'open' ? 'tonal' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-sm"
          >
            {stateLabel(filters.state)}
            <ChevronDown className="h-3.5 w-3.5 text-low" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {ISSUE_STATES.map((s) => (
            <DropdownMenuCheckboxItem
              key={s}
              checked={filters.state === s}
              onCheckedChange={() => onChange({ ...filters, state: s })}
            >
              {stateLabel(s)}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          {TASK_STATUSES.map((s) => (
            <DropdownMenuCheckboxItem
              key={s}
              checked={filters.state === s}
              onCheckedChange={() => onChange({ ...filters, state: s })}
            >
              {stateLabel(s)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Priority filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={filters.priorities.length > 0 ? 'tonal' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-sm"
          >
            {t('issues.filters.priority')}
            {filters.priorities.length > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-brand/15 text-brand-on-surface text-xs font-semibold">
                {filters.priorities.length}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-low" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuLabel className="text-xs text-low">
            {t('issues.filters.priority')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {PRIORITIES.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={filters.priorities.includes(p)}
              onCheckedChange={() => togglePriority(p)}
            >
              {t(`issues.filters.priorities.${p}`)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Label filter */}
      {availableLabels.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={filters.labels.length > 0 ? 'tonal' : 'outline'}
              size="sm"
              className="h-8 gap-1.5 text-sm"
            >
              {t('issues.filters.label')}
              {filters.labels.length > 0 && (
                <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-brand/15 text-brand-on-surface text-xs font-semibold">
                  {filters.labels.length}
                </span>
              )}
              <ChevronDown className="h-3.5 w-3.5 text-low" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-52 max-h-64 overflow-y-auto"
          >
            <DropdownMenuLabel className="text-xs text-low">
              {t('issues.filters.label')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {availableLabels.map((lbl) => (
              <DropdownMenuCheckboxItem
                key={lbl.name}
                checked={filters.labels.includes(lbl.name)}
                onCheckedChange={() => toggleLabel(lbl.name)}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {lbl.color && (
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: `#${lbl.color}` }}
                    />
                  )}
                  <span className="truncate">{lbl.name}</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Milestone/epic filter */}
      {availableMilestones.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={filters.milestones.length > 0 ? 'tonal' : 'outline'}
              size="sm"
              className="h-8 gap-1.5 text-sm"
            >
              {t('issues.filters.milestone')}
              {filters.milestones.length > 0 && (
                <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-brand/15 text-brand-on-surface text-xs font-semibold">
                  {filters.milestones.length}
                </span>
              )}
              <ChevronDown className="h-3.5 w-3.5 text-low" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-52 max-h-64 overflow-y-auto"
          >
            <DropdownMenuLabel className="text-xs text-low">
              {t('issues.filters.milestone')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {availableMilestones.map((m) => (
              <DropdownMenuCheckboxItem
                key={m}
                checked={filters.milestones.includes(m)}
                onCheckedChange={() => toggleMilestone(m)}
              >
                <span className="truncate">{m}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Worker filter */}
      {availableWorkers.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={filters.workers.length > 0 ? 'tonal' : 'outline'}
              size="sm"
              className="h-8 gap-1.5 text-sm"
            >
              {t('issues.filters.worker')}
              {filters.workers.length > 0 && (
                <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-brand/15 text-brand-on-surface text-xs font-semibold">
                  {filters.workers.length}
                </span>
              )}
              <ChevronDown className="h-3.5 w-3.5 text-low" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-52 max-h-64 overflow-y-auto"
          >
            <DropdownMenuLabel className="text-xs text-low">
              {t('issues.filters.worker')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {availableWorkers.map((w) => (
              <DropdownMenuCheckboxItem
                key={w.id}
                checked={filters.workers.includes(w.id)}
                onCheckedChange={() => toggleWorker(w.id)}
              >
                <span className="truncate">{w.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Group by */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={filters.groupBy !== 'none' ? 'tonal' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 text-sm"
          >
            {t('issues.filters.groupBy')}
            {filters.groupBy !== 'none' && (
              <span className="text-brand-on-surface">
                {t(`issues.filters.groupByOptions.${filters.groupBy}`)}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-low" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuLabel className="text-xs text-low">
            {t('issues.filters.groupBy')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {GROUP_BY_OPTIONS.map((g) => (
            <DropdownMenuCheckboxItem
              key={g}
              checked={filters.groupBy === g}
              onCheckedChange={() => onChange({ ...filters, groupBy: g })}
            >
              {t(`issues.filters.groupByOptions.${g}`)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Clear filters */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-sm text-low hover:text-high"
          onClick={clearFilters}
        >
          <X className="h-3.5 w-3.5" />
          {t('issues.filters.clear')}
        </Button>
      )}
    </div>
  );
}
