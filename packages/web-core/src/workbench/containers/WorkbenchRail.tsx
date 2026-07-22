import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  LayoutGrid,
  Settings,
  SquareKanban,
  Users,
} from 'lucide-react';
import { Rail, RailButton, RailSpacer } from '../ui/chrome';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  isIssuesDestination,
  isLocalWorkspacesDestination,
  isSprintDestination,
  isWorkersDestination,
} from '@/shared/lib/routes/appNavigation';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';

export function WorkbenchRail() {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const destination = useCurrentAppDestination();
  const { data: workers = [] } = useWorkers();

  const busyWorkers = useMemo(
    () => workers.filter((w) => w.active_workspace_id !== null).length,
    [workers]
  );

  return (
    <Rail>
      <RailButton
        label={t('appBar.sprint', { defaultValue: 'Sprint' })}
        isActive={isSprintDestination(destination)}
        onClick={() => appNavigation.goToSprint()}
      >
        <SquareKanban size={22} strokeWidth={1.5} aria-hidden />
      </RailButton>
      <RailButton
        label={t('appBar.issues', { defaultValue: 'Issues' })}
        isActive={isIssuesDestination(destination)}
        onClick={() => appNavigation.goToIssues()}
      >
        <ClipboardList size={22} strokeWidth={1.5} aria-hidden />
      </RailButton>
      <RailButton
        label={t('appBar.workers', { defaultValue: 'Workers' })}
        isActive={isWorkersDestination(destination)}
        badge={busyWorkers}
        onClick={() => appNavigation.goToWorkers()}
      >
        <Users size={22} strokeWidth={1.5} aria-hidden />
      </RailButton>
      <RailButton
        label={t('workspaces.title', { defaultValue: 'Workspaces' })}
        isActive={isLocalWorkspacesDestination(destination)}
        onClick={() => appNavigation.goToWorkspaces()}
      >
        <LayoutGrid size={22} strokeWidth={1.5} aria-hidden />
      </RailButton>
      <RailSpacer />
      <RailButton
        label={t('settings.title', { defaultValue: 'Settings' })}
        onClick={() => SettingsDialog.show()}
      >
        <Settings size={22} strokeWidth={1.5} aria-hidden />
      </RailButton>
    </Rail>
  );
}
