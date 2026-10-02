import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import {
  MODEL_BUCKETS,
  type WorkerModelBucket,
  type WorkerStatus,
} from '../model/workerStatus';

export interface WorkersFilterState {
  search: string;
  role: Set<string>;
  model: Set<WorkerModelBucket>;
  status: Set<WorkerStatus>;
}

export function emptyFilterState(): WorkersFilterState {
  return {
    search: '',
    role: new Set(),
    model: new Set(),
    status: new Set(),
  };
}

export function isFilterActive(filters: WorkersFilterState): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.role.size > 0 ||
    filters.model.size > 0 ||
    filters.status.size > 0
  );
}

const ROLE_VALUES: readonly string[] = [
  'developer',
  'analyst',
  'reviewer',
  'designer',
];
const STATUS_VALUES: readonly WorkerStatus[] = [
  'working',
  'idle',
  'stalled',
  'in_review',
  'waiting',
  'approved',
];

const CHIP_BASE =
  'inline-flex shrink-0 select-none items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide transition-colors';
const CHIP_INACTIVE =
  'border-border bg-secondary text-normal hover:bg-md-surface-container-high';

const ROLE_ACTIVE: Record<string, string> = {
  developer: 'border-info bg-info/10 text-info',
  analyst: 'border-success bg-success/10 text-success',
  reviewer: 'border-warning bg-warning/10 text-warning',
  designer: 'border-pink bg-pink/10 text-pink',
};

const MODEL_ACTIVE: Record<WorkerModelBucket, string> = {
  opus: 'border-merged bg-merged/10 text-merged',
  sonnet: 'border-teal bg-teal/10 text-teal',
  haiku: 'border-pink bg-pink/10 text-pink',
  fable: 'border-brand-on-surface bg-brand-on-surface/10 text-brand-on-surface',
};

const STATUS_ACTIVE: Record<WorkerStatus, string> = {
  working:
    'border-brand-on-surface bg-brand-on-surface/10 text-brand-on-surface',
  idle: 'border-border-strong bg-secondary text-normal',
  stalled: 'border-error bg-error/10 text-error',
  in_review: 'border-info bg-info/10 text-info',
  waiting: 'border-warning bg-warning/10 text-warning',
  approved: 'border-success bg-success/10 text-success',
};

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

interface ChipProps {
  active: boolean;
  activeClass: string;
  onClick: () => void;
  children: React.ReactNode;
}

function Chip({ active, activeClass, onClick, children }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(CHIP_BASE, active ? activeClass : CHIP_INACTIVE)}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

interface WorkersFilterBarProps {
  filters: WorkersFilterState;
  onChange: (next: WorkersFilterState) => void;
  visibleCount: number;
  totalCount: number;
}

export function WorkersFilterBar({
  filters,
  onChange,
  visibleCount,
  totalCount,
}: WorkersFilterBarProps) {
  const { t } = useTranslation('common');
  const active = isFilterActive(filters);

  const handleClear = () => onChange(emptyFilterState());

  return (
    <div
      role="search"
      aria-label={t('workers.filters.aria')}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-container-padding py-2.5"
    >
      <div className="relative shrink-0">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-low"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder={t('workers.filters.searchPlaceholder')}
          aria-label={t('workers.filters.searchAria')}
          autoComplete="off"
          className={cn(
            'h-7 w-[200px] rounded-md border border-border-strong bg-secondary pl-8 pr-2.5 text-sm text-high placeholder:text-low placeholder:opacity-80 outline-none transition-colors',
            'focus:border-brand-on-surface focus:bg-card focus:ring-2 focus:ring-brand-on-surface/15'
          )}
        />
      </div>

      <Divider />

      <div
        role="group"
        aria-label={t('workers.filters.roleGroupAria')}
        className="flex flex-wrap items-center gap-1.5"
      >
        <span className="mr-1 shrink-0 font-sans text-label uppercase tracking-wide text-low">
          {t('workers.filters.roleLabel')}
        </span>
        {ROLE_VALUES.map((value) => (
          <Chip
            key={value}
            active={filters.role.has(value)}
            activeClass={ROLE_ACTIVE[value] ?? ROLE_ACTIVE.developer}
            onClick={() =>
              onChange({ ...filters, role: toggle(filters.role, value) })
            }
          >
            {t(`workers.roles.${value}`)}
          </Chip>
        ))}
      </div>

      <Divider />

      <div
        role="group"
        aria-label={t('workers.filters.modelGroupAria')}
        className="flex flex-wrap items-center gap-1.5"
      >
        <span className="mr-1 shrink-0 font-sans text-label uppercase tracking-wide text-low">
          {t('workers.filters.modelLabel')}
        </span>
        {MODEL_BUCKETS.map((value) => (
          <Chip
            key={value}
            active={filters.model.has(value)}
            activeClass={MODEL_ACTIVE[value]}
            onClick={() =>
              onChange({ ...filters, model: toggle(filters.model, value) })
            }
          >
            <span className="font-mono normal-case">{value}</span>
          </Chip>
        ))}
      </div>

      <Divider />

      <div
        role="group"
        aria-label={t('workers.filters.statusGroupAria')}
        className="flex flex-wrap items-center gap-1.5"
      >
        <span className="mr-1 shrink-0 font-sans text-label uppercase tracking-wide text-low">
          {t('workers.filters.statusLabel')}
        </span>
        {STATUS_VALUES.map((value) => (
          <Chip
            key={value}
            active={filters.status.has(value)}
            activeClass={STATUS_ACTIVE[value]}
            onClick={() =>
              onChange({ ...filters, status: toggle(filters.status, value) })
            }
          >
            {t(`workers.filters.status.${value}`)}
          </Chip>
        ))}
      </div>

      {active && (
        <div
          className="ml-auto flex shrink-0 items-center gap-2"
          aria-live="polite"
        >
          <span className="font-sans text-label font-semibold text-low tabular-nums">
            <strong className="text-brand-on-surface">{visibleCount}</strong>{' '}
            {t('workers.filters.resultCount', { total: totalCount })}
          </span>
          <button
            type="button"
            onClick={handleClear}
            aria-label={t('workers.filters.clearAria')}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-brand-on-surface/20 bg-brand-on-surface/10 px-2.5 py-0.5 text-label font-semibold uppercase tracking-wide text-brand-on-surface transition-colors',
              'hover:bg-brand-on-surface hover:text-white'
            )}
          >
            <X className="h-3 w-3" strokeWidth={2.5} aria-hidden />
            {t('workers.filters.clear')}
          </button>
        </div>
      )}
    </div>
  );
}
