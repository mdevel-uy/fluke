import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { InputField } from '@vibe/ui/components/InputField';
import {
  SidebarRepoSection,
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';
import type { IssueLabel } from 'shared/types';
import type {
  IssueFilters,
  IssueStateFilter,
  IssueTaskStatusFilter,
} from './IssuesToolbar';

const VIEW_STATES: IssueStateFilter[] = ['open', 'all', 'closed'];
const TASK_STATES: IssueTaskStatusFilter[] = [
  'queued',
  'in_progress',
  'in_review',
];

interface IssuesSidebarProps {
  filters: IssueFilters;
  availableLabels: IssueLabel[];
  onChange: (filters: IssueFilters) => void;
}

/**
 * Shell sidebar for the Issues section (SHELL-SPEC R9): search, repository
 * picker and views (issue state + task status), mirroring the list's URL
 * filter params.
 */
export function IssuesSidebar({
  filters,
  availableLabels,
  onChange,
}: IssuesSidebarProps) {
  const { t } = useTranslation('common');

  const stateLabel = (s: IssueStateFilter) =>
    (TASK_STATES as string[]).includes(s)
      ? t(`issues.taskStatus.${s}`)
      : t(`issues.filters.state.${s}`);

  const toggleLabel = (name: string) =>
    onChange({
      ...filters,
      labels: filters.labels.includes(name)
        ? filters.labels.filter((l) => l !== name)
        : [...filters.labels, name],
    });

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
      <CollapsibleSectionHeader
        title={t('issues.title', { defaultValue: 'Issues' })}
        collapsible={false}
      />
      </div>
      <div className="px-base py-half flex-none">
        <InputField
          variant="search"
          value={filters.search}
          onChange={(search) => onChange({ ...filters, search })}
          placeholder={t('issues.filters.searchPlaceholder')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarRepoSection persistKey="issues-sidebar-repo" />
        <SidebarSection
          persistKey="issues-sidebar-views"
          title={t('issues.filters.stateLabel')}
        >
          {[...VIEW_STATES, ...TASK_STATES].map((state) => (
            <SidebarRow
              key={state}
              selected={filters.state === state}
              onClick={() => onChange({ ...filters, state })}
            >
              <span className="truncate">{stateLabel(state)}</span>
            </SidebarRow>
          ))}
        </SidebarSection>
        {availableLabels.length > 0 && (
          <SidebarSection
            persistKey="issues-sidebar-labels"
            title={t('issues.filters.label')}
            count={availableLabels.length}
            defaultOpen={false}
          >
            {availableLabels.map((label) => (
              <SidebarRow
                key={label.name}
                selected={filters.labels.includes(label.name)}
                onClick={() => toggleLabel(label.name)}
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
      </div>
    </div>
  );
}
