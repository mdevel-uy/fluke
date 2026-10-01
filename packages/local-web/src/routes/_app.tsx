import { type ReactNode } from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { Provider as NiceModalProvider } from '@ebay/nice-modal-react';
import { SequenceTrackerProvider } from '@/shared/keyboard/SequenceTracker';
import { SequenceIndicator } from '@/shared/keyboard/SequenceIndicator';
import { useWorkspaceShortcuts } from '@/shared/keyboard/useWorkspaceShortcuts';
import { useIssueShortcuts } from '@/shared/keyboard/useIssueShortcuts';
import { useKeyShowHelp, Scope } from '@/shared/keyboard';
import { KeyboardShortcutsDialog } from '@/shared/dialogs/shared/KeyboardShortcutsDialog';
import { TerminalProvider } from '@/shared/providers/TerminalProvider';
import { HostIdProvider } from '@/shared/providers/HostIdProvider';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { LogsPanelProvider } from '@/shared/providers/LogsPanelProvider';
import { ActionsProvider } from '@/shared/providers/ActionsProvider';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { SharedAppLayout } from '@/shared/components/ui-new/containers/SharedAppLayout';
import { LicenseBanner } from '@/shared/components/LicenseBanner';
import { useLicenseStatus } from '@/shared/hooks/useLicenseStatus';
import {
  ProviderAuthBanner,
  useProviderAuthAlert,
} from '@/shared/components/ProviderAuthBanner';
import { LocalTaskNotifications } from '@web/app/notifications/LocalTaskNotifications';
import { PushNavigationBridge } from '@web/app/notifications/PushNavigationBridge';

function KeyboardShortcutsHandler() {
  useKeyShowHelp(
    () => {
      KeyboardShortcutsDialog.show();
    },
    { scope: Scope.GLOBAL }
  );
  useWorkspaceShortcuts();
  useIssueShortcuts();
  return null;
}

function ExecutionProcessesProviderWrapper({
  children,
}: {
  children: ReactNode;
}) {
  const { selectedSessionId } = useWorkspaceContext();

  return (
    <ExecutionProcessesProvider sessionId={selectedSessionId}>
      {children}
    </ExecutionProcessesProvider>
  );
}

function AppRouteProviders({ children }: { children: ReactNode }) {
  return (
    <HostIdProvider>
      <WorkspaceProvider>
        <ExecutionProcessesProviderWrapper>
          <LogsPanelProvider>
            <ActionsProvider>
              {/* NiceModal renders dialogs as siblings of children at the
                  Provider level, so it must be inside all providers that
                  dialogs depend on (Workspace, Actions, etc.). */}
              <NiceModalProvider>{children}</NiceModalProvider>
            </ActionsProvider>
          </LogsPanelProvider>
        </ExecutionProcessesProviderWrapper>
      </WorkspaceProvider>
    </HostIdProvider>
  );
}

function AppLayoutRouteComponent() {
  const { hostId } = useParams({ strict: false });
  const { data: license } = useLicenseStatus();
  const providerAlert = useProviderAuthAlert();

  // Only reserve the banner row when there is actually something to show, so
  // the common (valid / not enforced) case keeps the original layout. Both
  // banners share that single row.
  const showLicense =
    !!license && license.enforced && license.status !== 'valid';
  const banner =
    showLicense || providerAlert.reason ? (
      <div>
        {showLicense && <LicenseBanner license={license} />}
        {providerAlert.reason && (
          <ProviderAuthBanner
            reason={providerAlert.reason}
            onDismiss={providerAlert.dismiss}
          />
        )}
      </div>
    ) : undefined;

  return (
    <AppRouteProviders key={hostId ?? 'local'}>
      <LocalTaskNotifications />
      <PushNavigationBridge />
      <SequenceTrackerProvider>
        <SequenceIndicator />
        <KeyboardShortcutsHandler />
        <TerminalProvider>
          <SharedAppLayout topBanner={banner} />
        </TerminalProvider>
      </SequenceTrackerProvider>
    </AppRouteProviders>
  );
}

export const Route = createFileRoute('/_app')({
  component: AppLayoutRouteComponent,
});
