import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import {
  Check,
  ChevronUp,
  Command,
  FolderClosed,
  GitBranch,
  HardDrive,
  Hourglass,
  Plus,
  SquareKanban,
  TriangleAlert,
} from 'lucide-react';
import {
  StatusBar,
  StatusBarItem,
  StatusBarSpacer,
} from '@vibe/ui/components/StatusBar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
import { useSyncErrorContext } from '@/shared/hooks/useSyncErrorContext';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useRemoteCloudHostsState } from '@/shared/hooks/useRemoteCloudHosts';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useConcurrencyStatus } from '@/shared/hooks/useConcurrencyStatus';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';

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
  const navigate = useNavigate();
  const appNavigation = useAppNavigation();

  // Sync state (R26) — unified with the navbar's notion: stream errors plus
  // degraded remote auth count as "not in sync".
  const syncErrorContext = useSyncErrorContext();
  const { remoteAuthDegraded } = useUserSystem();
  const syncErrorCount =
    (syncErrorContext?.errors?.length ?? 0) + (remoteAuthDegraded ? 1 : 0);

  // R25 · project = repo + environment (local | remote host)
  const hostId = useHostId();
  const { repos } = useRepos();
  const selectedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setSelectedRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);
  const { data: remoteHostsState } = useRemoteCloudHostsState();
  const remoteHosts = remoteHostsState?.hosts ?? [];
  const destinationKind = useCurrentAppDestination()?.kind ?? null;

  // Sprint and Issues mirror the repo into the URL (`?repo=`) and derive the
  // active repo from there — updating just the store leaves those views on
  // the old repo until the next mount. Mirror the change into the URL so the
  // kanban / issues list refetches immediately.
  const handleSelectRepo = useCallback(
    (repoId: string) => {
      setSelectedRepoId(repoId);
      if (destinationKind === 'sprint') {
        appNavigation.goToSprint(repoId);
      } else if (destinationKind === 'issues') {
        appNavigation.goToIssues(repoId);
      }
    },
    [setSelectedRepoId, destinationKind, appNavigation]
  );

  const activeRepo = useMemo(
    () => repos.find((r) => r.id === selectedRepoId) ?? repos[0] ?? null,
    [repos, selectedRepoId]
  );
  const envLabel = useMemo(() => {
    if (!hostId) return t('statusBar.envLocal', { defaultValue: 'local' });
    return (
      remoteHosts.find((h) => h.id === hostId)?.name ??
      t('statusBar.envRemote', { defaultValue: 'remote' })
    );
  }, [hostId, remoteHosts, t]);

  const handleSwitchToLocal = useCallback(() => {
    void navigate({ to: '/workspaces' });
  }, [navigate]);

  const handleSwitchToHost = useCallback(
    (id: string) => {
      void navigate({
        to: '/hosts/$hostId/workspaces',
        params: { hostId: id },
      });
    },
    [navigate]
  );

  // R27 · fleet signal: running / attention counts over active workspaces
  const { activeWorkspaces } = useWorkspaceContext();
  const runningCount = useMemo(
    () => activeWorkspaces.filter((ws) => ws.isRunning).length,
    [activeWorkspaces]
  );
  const attentionCount = useMemo(
    () =>
      activeWorkspaces.filter(
        (ws) =>
          !ws.isRunning &&
          (ws.hasPendingApproval ||
            ws.hasStalledTask ||
            ws.latestProcessStatus === 'failed')
      ).length,
    [activeWorkspaces]
  );
  const setRightSidebarVisible = useUiPreferencesStore(
    (s) => s.setRightSidebarVisible
  );
  const handleFleetClick = useCallback(() => {
    setRightSidebarVisible(true);
    appNavigation.goToWorkspaces();
  }, [setRightSidebarVisible, appNavigation]);

  // Issue #346 · concurrency semaphore signal. Only shown when a
  // non-zero limit is configured — `limit === 0` means "unlimited" and
  // there is nothing to display.
  const { data: concurrency } = useConcurrencyStatus();
  const showConcurrency = !!concurrency && concurrency.limit > 0;
  const queuedCount = concurrency?.queued.length ?? 0;

  const repoLabel = (repo: { display_name?: string | null; name: string }) =>
    repo.display_name || repo.name;

  return (
    <StatusBar className={className}>
      <StatusBarItem variant="brand" readOnly>
        <SquareKanban size={12} strokeWidth={1.75} aria-hidden />
        mkanban
      </StatusBarItem>

      {/* R25 · project/environment selector (menu opens upward) */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('statusBar.switchProject', {
            defaultValue: 'Switch project',
          })}
          className={cn(
            'flex items-center gap-1 px-2 whitespace-nowrap text-xs font-semibold',
            'text-normal hover:bg-secondary cursor-pointer focus:outline-none'
          )}
        >
          <FolderClosed size={12} strokeWidth={1.75} aria-hidden />
          {activeRepo ? (
            <>
              {repoLabel(activeRepo)}{' '}
              <span className="font-normal text-low">· {envLabel}</span>
            </>
          ) : (
            <span className="font-normal text-low">
              {t('statusBar.noProject', { defaultValue: 'No project' })}
            </span>
          )}
          <ChevronUp size={10} strokeWidth={2} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-[280px]">
          <DropdownMenuLabel>
            {t('statusBar.projects', { defaultValue: 'Projects' })}
          </DropdownMenuLabel>
          {repos.map((repo) => (
            <DropdownMenuItem
              key={repo.id}
              onSelect={() => handleSelectRepo(repo.id)}
            >
              <span className="w-4 flex-none text-brand-on-surface">
                {repo.id === activeRepo?.id && (
                  <Check size={14} strokeWidth={2} />
                )}
              </span>
              <span className="flex-1 truncate">{repoLabel(repo)}</span>
              <span
                className={cn(
                  'ml-2 rounded-full border border-border px-1.5 text-[10px] leading-[15px] text-low',
                  hostId && 'border-brand/40 text-brand-on-surface'
                )}
              >
                {envLabel}
              </span>
            </DropdownMenuItem>
          ))}
          {(remoteHosts.length > 0 || hostId) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {t('statusBar.environments', { defaultValue: 'Environments' })}
              </DropdownMenuLabel>
              {hostId && (
                <DropdownMenuItem onSelect={handleSwitchToLocal}>
                  <span className="w-4 flex-none" />
                  <HardDrive size={14} strokeWidth={1.75} />
                  <span className="flex-1">
                    {t('statusBar.envLocal', { defaultValue: 'local' })}
                  </span>
                </DropdownMenuItem>
              )}
              {remoteHosts
                .filter((h) => h.id !== hostId)
                .map((host) => (
                  <DropdownMenuItem
                    key={host.id}
                    onSelect={() => handleSwitchToHost(host.id)}
                  >
                    <span className="w-4 flex-none" />
                    <span
                      className={cn(
                        'h-2 w-2 flex-none rounded-full',
                        host.status === 'online'
                          ? 'bg-success'
                          : 'bg-border-strong'
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{host.name}</span>
                  </DropdownMenuItem>
                ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void SettingsDialog.show({ initialSection: 'repos' })
            }
          >
            <span className="w-4 flex-none" />
            <Plus size={14} strokeWidth={1.75} />
            <span className="flex-1">
              {t('statusBar.openProject', { defaultValue: 'Open project…' })}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void SettingsDialog.show({ initialSection: 'relay' })
            }
          >
            <span className="w-4 flex-none" />
            <HardDrive size={14} strokeWidth={1.75} />
            <span className="flex-1">
              {t('statusBar.pairRemoteHost', {
                defaultValue: 'Pair remote host…',
              })}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
      {/* R26 · base branch of the active project */}
      {activeRepo?.default_target_branch && (
        <StatusBarItem readOnly className="font-mono text-[11px]">
          <GitBranch size={12} strokeWidth={1.75} aria-hidden />
          {activeRepo.default_target_branch}
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

      {/* Issue #346 · concurrency semaphore: N/M coding-agent slots
          used. Hidden when the plan limit is 0 (unlimited). */}
      {showConcurrency && (
        <StatusBarItem
          readOnly
          variant={queuedCount > 0 ? 'brand' : 'default'}
          title={
            queuedCount > 0
              ? t('statusBar.slotsQueuedTooltip', {
                  defaultValue:
                    'Concurrency limit reached. {{count}} execution(s) waiting for a free slot.',
                  count: queuedCount,
                })
              : t('statusBar.slotsTooltip', {
                  defaultValue:
                    'Agent slots in use — set by AGENT_CONCURRENCY_LIMIT / config.',
                })
          }
        >
          <Hourglass size={12} strokeWidth={1.75} aria-hidden />
          {t('statusBar.slots', {
            defaultValue: '{{used}}/{{limit}} slots',
            used: concurrency.used,
            limit: concurrency.limit,
          })}
          {queuedCount > 0 &&
            ` · ${t('statusBar.slotsQueued', {
              defaultValue: '{{count}} queued',
              count: queuedCount,
            })}`}
        </StatusBarItem>
      )}

      {/* R27 · fleet signal → Workspaces with the aside shown */}
      {(runningCount > 0 || attentionCount > 0) && (
        <StatusBarItem
          onClick={handleFleetClick}
          title={t('statusBar.fleetTooltip', {
            defaultValue: 'Show workspaces',
          })}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              runningCount > 0
                ? 'bg-brand-on-surface animate-pulse'
                : 'bg-warning'
            )}
            aria-hidden
          />
          {[
            runningCount > 0
              ? t('statusBar.running', {
                  defaultValue: '{{count}} running',
                  count: runningCount,
                })
              : null,
            attentionCount > 0
              ? t('statusBar.attention', {
                  defaultValue: '{{count}} attention',
                  count: attentionCount,
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </StatusBarItem>
      )}
      <StatusBarItem
        onClick={() => CommandBarDialog.show()}
        aria-label="Command bar"
      >
        <Command size={11} strokeWidth={1.75} aria-hidden />K
      </StatusBarItem>
    </StatusBar>
  );
}
