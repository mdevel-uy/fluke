import * as React from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Input } from './Input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';

export interface FilterBarOption {
  value: string;
  label: React.ReactNode;
  /** Hex color without the leading `#`; rendered as a dot before the label. */
  color?: string | null;
  /** Draw a separator above this option. */
  separatorBefore?: boolean;
}

/**
 * How the trigger reflects the current selection:
 * - `count` — filter name plus a count badge (default, for multi-select)
 * - `selection` — the selected option replaces the filter name
 * - `append` — filter name followed by the selected option, accented
 */
export type FilterBarTriggerDisplay = 'count' | 'selection' | 'append';

export interface FilterBarFilter {
  id: string;
  /** Trigger label shown when nothing is selected. */
  label: string;
  /** `single` collapses the selection to one value. Defaults to `multi`. */
  mode?: 'multi' | 'single';
  options: FilterBarOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  triggerDisplay?: FilterBarTriggerDisplay;
  /** Heading inside the menu. Defaults to `label`; pass `null` to omit. */
  menuLabel?: string | null;
  /** Adds a leading "no filter" entry in single mode, e.g. "All epics". */
  clearOptionLabel?: string;
  /** Overrides the default `selected.length > 0` accent rule. */
  active?: boolean;
  menuClassName?: string;
  /** Skip rendering entirely, e.g. when there are no options to offer. */
  hidden?: boolean;
}

export interface FilterBarSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel?: string;
  /** Debounce in ms before `onChange` fires. Defaults to 200. */
  debounceMs?: number;
}

export interface FilterBarProps {
  search?: FilterBarSearch;
  filters?: FilterBarFilter[];
  onClearAll?: () => void;
  clearAllLabel?: string;
  /** Overrides the default "any filter or search is set" rule. */
  hasActiveFilters?: boolean;
  /** Right-aligned slot, e.g. a "New issue" CTA. */
  trailing?: React.ReactNode;
  className?: string;
}

const CONTROL = 'h-8 gap-1.5 text-sm';

function OptionLabel({ option }: { option: FilterBarOption }) {
  if (!option.color) return <span className="truncate">{option.label}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: `#${option.color}` }}
      />
      <span className="truncate">{option.label}</span>
    </span>
  );
}

function FilterDropdown({ filter }: { filter: FilterBarFilter }) {
  const {
    label,
    mode = 'multi',
    options,
    selected,
    onChange,
    triggerDisplay = 'count',
    menuLabel,
    clearOptionLabel,
    active,
    menuClassName,
  } = filter;

  const isActive = active ?? selected.length > 0;
  const selectedOptions = options.filter((o) => selected.includes(o.value));
  const heading = menuLabel === undefined ? label : menuLabel;

  const toggle = (value: string) => {
    if (mode === 'single') {
      onChange(selected.includes(value) ? [] : [value]);
      return;
    }
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  let triggerBody: React.ReactNode;
  if (triggerDisplay === 'selection' && selectedOptions.length > 0) {
    triggerBody = <OptionLabel option={selectedOptions[0]} />;
  } else if (triggerDisplay === 'append') {
    triggerBody = (
      <>
        {label}
        {selectedOptions.length > 0 && (
          <span className="text-brand-on-surface">
            {selectedOptions[0].label}
          </span>
        )}
      </>
    );
  } else {
    triggerBody = (
      <>
        {label}
        {selected.length > 0 && (
          <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand/15 px-1 text-xs font-semibold text-brand-on-surface">
            {selected.length}
          </span>
        )}
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={isActive ? 'tonal' : 'outline'}
          size="sm"
          className={CONTROL}
        >
          {triggerBody}
          <ChevronDown className="h-3.5 w-3.5 text-low" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn('max-h-64 w-52 overflow-y-auto', menuClassName)}
      >
        {heading && (
          <>
            <DropdownMenuLabel className="text-xs text-low">
              {heading}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {clearOptionLabel && (
          <>
            <DropdownMenuCheckboxItem
              checked={selected.length === 0}
              onCheckedChange={() => onChange([])}
            >
              <span className="text-low">{clearOptionLabel}</span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        {options.map((option) => (
          <React.Fragment key={option.value}>
            {option.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuCheckboxItem
              checked={selected.includes(option.value)}
              onCheckedChange={() => toggle(option.value)}
            >
              <OptionLabel option={option} />
            </DropdownMenuCheckboxItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterBarSearchInput({ search }: { search: FilterBarSearch }) {
  const { value, onChange, placeholder, clearLabel, debounceMs = 200 } = search;
  const [local, setLocal] = React.useState(value);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt external resets (e.g. "clear all") without fighting local typing.
  React.useEffect(() => {
    setLocal(value);
  }, [value]);

  React.useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const push = (next: string) => {
    setLocal(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(next), debounceMs);
  };

  return (
    <div className="relative min-w-[180px] max-w-xs flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-low" />
      <Input
        value={local}
        onChange={(e) => push(e.target.value)}
        placeholder={placeholder}
        className={cn('h-8 pl-8 text-sm', local && 'pr-8')}
      />
      {local && (
        <button
          type="button"
          onClick={() => push('')}
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-low transition-colors hover:text-high"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * The search + filter row that sits under a `PageHeader`. One implementation
 * for every list view, so search, pills and counters read the same everywhere.
 */
export function FilterBar({
  search,
  filters = [],
  onClearAll,
  clearAllLabel,
  hasActiveFilters,
  trailing,
  className,
}: FilterBarProps) {
  const visibleFilters = filters.filter((f) => !f.hidden);
  const showClear =
    onClearAll !== undefined &&
    (hasActiveFilters ??
      (!!search?.value || visibleFilters.some((f) => f.selected.length > 0)));

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border/60 bg-primary px-6 py-3',
        className
      )}
    >
      {search && <FilterBarSearchInput search={search} />}
      {visibleFilters.map((filter) => (
        <FilterDropdown key={filter.id} filter={filter} />
      ))}
      {showClear && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(CONTROL, 'text-low hover:text-high')}
          onClick={onClearAll}
        >
          <X className="h-3.5 w-3.5" />
          {clearAllLabel}
        </Button>
      )}
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  );
}
