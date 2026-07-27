import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  SidebarRepoSection,
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';

interface AnalystDeskSidebarProps {
  analysts: WorkerResponse[];
  selectedAnalystId: string | null;
  onSelectAnalyst: (analystId: string) => void;
}

/**
 * Shell sidebar for the Analyst Desk section: repository picker plus the
 * analyst roster (selection drives the desk's active analyst).
 */
export function AnalystDeskSidebar({
  analysts,
  selectedAnalystId,
  onSelectAnalyst,
}: AnalystDeskSidebarProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-lowest">
      <div className="flex-none">
      <CollapsibleSectionHeader
        title={t('analystDesk.title')}
        collapsible={false}
        className="border-b"
      />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarRepoSection persistKey="analyst-desk-sidebar-repo" />
        {analysts.length > 0 && (
          <SidebarSection
            persistKey="analyst-desk-sidebar-analysts"
            title={t('analystDesk.analystsLabel')}
            count={analysts.length}
          >
            {analysts.map((analyst) => (
              <SidebarRow
                key={analyst.id}
                selected={analyst.id === selectedAnalystId}
                onClick={() => onSelectAnalyst(analyst.id)}
              >
                <span className="truncate">{analyst.name}</span>
              </SidebarRow>
            ))}
          </SidebarSection>
        )}
      </div>
    </div>
  );
}
