import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { InputField } from '@vibe/ui/components/InputField';
import {
  SidebarRepoSection,
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';
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
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
      <CollapsibleSectionHeader
        title={t('sprint.title')}
        collapsible={false}
        className="border-b"
      />
      </div>
      <div className="px-base py-half flex-none">
        <InputField
          variant="search"
          value={filters.q}
          onChange={(value) => setFilter('q', value)}
          placeholder={t('sprint.filters.searchPlaceholder', {
            defaultValue: 'Filter issues…',
          })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarRepoSection persistKey="sprint-sidebar-repo" />
        {workers.length > 0 && (
          <SidebarSection
            persistKey="sprint-sidebar-workers"
            title={t('sprint.filters.worker', { defaultValue: 'Worker' })}
            count={workers.length}
          >
            {workers.map((worker) => (
              <SidebarRow
                key={worker.id}
                selected={filters.worker === worker.id}
                onClick={() => toggle('worker', worker.id)}
              >
                <span className="truncate">{worker.name}</span>
              </SidebarRow>
            ))}
          </SidebarSection>
        )}
        <SidebarSection
          persistKey="sprint-sidebar-priority"
          title={t('sprint.filters.priority', { defaultValue: 'Priority' })}
        >
          {PRIORITIES.map((priority) => (
            <SidebarRow
              key={priority}
              selected={filters.priority === priority}
              onClick={() => toggle('priority', priority)}
            >
              <PriorityBadge priority={priority} showLabel />
            </SidebarRow>
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
              <SidebarRow
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
              </SidebarRow>
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
              <SidebarRow
                key={epic}
                selected={filters.epic === epic}
                onClick={() => toggle('epic', epic)}
              >
                <span className="truncate">{epic}</span>
              </SidebarRow>
            ))}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
