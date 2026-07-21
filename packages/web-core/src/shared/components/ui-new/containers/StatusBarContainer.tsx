import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Command, SquareKanban, TriangleAlert } from 'lucide-react';
import {
  StatusBar,
  StatusBarItem,
  StatusBarSpacer,
} from '@vibe/ui/components/StatusBar';
import { useSyncErrorContext } from '@/shared/hooks/useSyncErrorContext';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';

interface StatusBarContainerProps {
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;
  className?: string;
}

export function StatusBarContainer({
  appVersion,
  updateVersion,
  onUpdateClick,
  className,
}: StatusBarContainerProps) {
  const { t } = useTranslation('common');
  const syncErrorContext = useSyncErrorContext();
  const syncErrorCount = useMemo(
    () => syncErrorContext?.errors?.length ?? 0,
    [syncErrorContext?.errors]
  );

  return (
    <StatusBar className={className}>
      <StatusBarItem variant="brand" readOnly>
        <SquareKanban size={12} strokeWidth={1.75} aria-hidden />
        Vibe
      </StatusBarItem>
      {appVersion && <StatusBarItem readOnly>v{appVersion}</StatusBarItem>}
      {syncErrorCount > 0 ? (
        <StatusBarItem
          variant="error"
          readOnly
          title={t('navbar.syncErrors.tooltip', {
            defaultValue: 'Sync errors',
          })}
        >
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          {syncErrorCount} sync
        </StatusBarItem>
      ) : (
        <StatusBarItem readOnly>
          <Check size={12} strokeWidth={1.75} aria-hidden />
          sync
        </StatusBarItem>
      )}
      {updateVersion && (
        <StatusBarItem
          onClick={onUpdateClick}
          className="text-brand-on-surface"
        >
          Update to v{updateVersion}
        </StatusBarItem>
      )}
      <StatusBarSpacer />
      <StatusBarItem
        onClick={() => CommandBarDialog.show()}
        aria-label="Command bar"
      >
        <Command size={11} strokeWidth={1.75} aria-hidden />K
      </StatusBarItem>
    </StatusBar>
  );
}
