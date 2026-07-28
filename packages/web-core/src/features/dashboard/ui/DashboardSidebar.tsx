import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  SidebarSectionsMenu,
  useHiddenSections,
} from '@vibe/ui/components/SidebarSectionsMenu';
import {
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';

export const DASHBOARD_ANCHORS = {
  overview: 'dash-overview',
  workers: 'dash-workers',
  pipeline: 'dash-pipeline',
  impact: 'dash-impact',
  pullRequests: 'dash-prs',
  activity: 'dash-activity',
} as const;

interface DashboardSidebarProps {
  showLimits: boolean;
}

function scrollToAnchor(id: string) {
  document
    .getElementById(id)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Shell sidebar for the Dashboard section (SHELL-SPEC R9): panel navigation.
 */
export function DashboardSidebar({ showLimits }: DashboardSidebarProps) {
  const { t } = useTranslation('common');

  const items: Array<{ id: string; label: string }> = [
    { id: DASHBOARD_ANCHORS.overview, label: t('dashboard.sidebar.overview', { defaultValue: 'Overview' }) },
    { id: DASHBOARD_ANCHORS.workers, label: t('appBar.workers') },
    { id: DASHBOARD_ANCHORS.pipeline, label: t('dashboard.sidebar.pipeline', { defaultValue: 'Pipeline' }) },
    ...(showLimits
      ? [{ id: DASHBOARD_ANCHORS.pipeline, label: t('dashboard.sidebar.limits', { defaultValue: 'Claude limits' }) }]
      : []),
    { id: DASHBOARD_ANCHORS.impact, label: t('dashboard.sidebar.impact', { defaultValue: 'Impact' }) },
    { id: DASHBOARD_ANCHORS.pullRequests, label: t('dashboard.sidebar.pullRequests', { defaultValue: 'Pull requests' }) },
    { id: DASHBOARD_ANCHORS.activity, label: t('dashboard.sidebar.activity', { defaultValue: 'Activity' }) },
  ];

  const [hidden, toggleSection] = useHiddenSections('dashboard');
  const menuSections = [
    {
      key: 'panels',
      label: t('dashboard.sidebar.panels', { defaultValue: 'Panels' }),
    },
  ];

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
      <CollapsibleSectionHeader
        title={t('appBar.dashboard')}
        collapsible={false}
        headerExtra={
          <SidebarSectionsMenu
            sections={menuSections}
            hidden={hidden}
            onToggle={toggleSection}
          />
        }
      />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {!hidden.panels && (
        <SidebarSection
          persistKey="dashboard-sidebar-panels"
          title={t('dashboard.sidebar.panels', { defaultValue: 'Panels' })}
          count={items.length}
        >
          {items.map((item, index) => (
            <SidebarRow
              key={`${item.id}-${index}`}
              onClick={() => scrollToAnchor(item.id)}
            >
              <span className="truncate">{item.label}</span>
            </SidebarRow>
          ))}
        </SidebarSection>
        )}
      </div>
    </div>
  );
}
