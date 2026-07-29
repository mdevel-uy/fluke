import { useTranslation } from 'react-i18next';
import { ExternalLink, FileCode, PanelsTopLeft } from 'lucide-react';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  AsideSection,
  GhostButton,
  Kv,
  formatElapsed,
} from '@/shared/components/ui-new/aside/primitives';
import {
  WorkerDetailCard,
  type WorkerCardState,
} from '@/shared/components/ui-new/aside/WorkerDetailCard';
import { PERSIST_KEYS, useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { FleetBranch, AttentionReason } from '../model/useFleetBranches';

function workerCardState(branch: FleetBranch): WorkerCardState {
  if (branch.group === 'attention') return 'attention';
  if (branch.workspace.isRunning) return 'running';
  return 'idle';
}

function useAttentionLabel(reason: AttentionReason | null): string | undefined {
  const { t } = useTranslation('common');
  switch (reason) {
    case 'conflict':
      return t('sourceControl.attention.conflict', {
        defaultValue: 'Stopped on conflicts',
      });
    case 'approval':
      return t('sourceControl.attention.approval', {
        defaultValue: 'Waiting for approval',
      });
    case 'stalled':
      return t('sourceControl.attention.stalled', {
        defaultValue: 'Task stalled',
      });
    case 'review':
      return t('sourceControl.attention.review', {
        defaultValue: 'PR waiting for review',
      });
    case 'activity':
      return t('sourceControl.attention.activity', {
        defaultValue: 'Unseen activity',
      });
    default:
      return undefined;
  }
}

function ActRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof FileCode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[26px] w-full cursor-pointer items-center gap-2 px-3.5 text-left text-sm text-normal hover:bg-secondary hover:text-high"
    >
      <Icon className="h-3.5 w-3.5 flex-none text-low" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * Master-detail aside for the selected fleet branch (SHELL-SPEC R18 applied
 * to Source control): worker card, per-repo Git status, PR and quick
 * actions. The Conflicts section (R39) plugs in here.
 */
export function SourceControlAside({ branch }: { branch: FleetBranch }) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const ws = branch.workspace;
  const attentionLabel = useAttentionLabel(branch.attentionReason);

  const contextPct = ws.contextUsage
    ? (ws.contextUsage.totalTokens / ws.contextUsage.contextWindow) * 100
    : undefined;

  const openInEditor = () => {
    useUiPreferencesStore.getState().setWorkspacesSidebarMode('explorer');
    useUiPreferencesStore.getState().openWorkspaceViewTab(ws.id, 'editor');
    appNavigation.goToWorkspace(ws.id);
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader title={ws.branch} collapsible={false} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <WorkerDetailCard
          noAgent={!ws.workerName && !ws.isRunning}
          name={ws.workerName}
          role={ws.workerRole}
          model={ws.workerModel}
          lastActivity={ws.latestActivity}
          contextPct={contextPct}
          state={workerCardState(branch)}
          attentionLabel={attentionLabel}
          elapsed={formatElapsed(ws.latestProcessStartedAt)}
        />

        <AsideSection
          persistKey={PERSIST_KEYS.asideGitSection}
          title={t('sourceControl.aside.git', { defaultValue: 'Git' })}
        >
          {(branch.status ?? []).map((repo) => (
            <div key={repo.repo_id} className="pb-1">
              {(branch.status?.length ?? 0) > 1 && (
                <Kv
                  k={t('sourceControl.aside.repo', { defaultValue: 'Repo' })}
                  v={repo.repo_name}
                  mono
                />
              )}
              <Kv
                k={t('sourceControl.aside.branch', { defaultValue: 'Branch' })}
                v={ws.branch}
                mono
              />
              <Kv
                k={t('sourceControl.aside.base', { defaultValue: 'Base' })}
                v={repo.target_branch_name}
                mono
              />
              <Kv
                k={t('sourceControl.aside.aheadBehind', {
                  defaultValue: 'Ahead / behind',
                })}
                v={`+${repo.commits_ahead ?? 0} / ${repo.commits_behind ?? 0}`}
                mono
              />
              {repo.head_oid && (
                <Kv
                  k={t('sourceControl.aside.lastCommit', {
                    defaultValue: 'Last commit',
                  })}
                  v={repo.head_oid.slice(0, 7)}
                  mono
                />
              )}
            </div>
          ))}
          {!branch.status && (
            <div className="px-3.5 py-1 text-xs text-low">
              {t('sourceControl.aside.loading', { defaultValue: 'Loading…' })}
            </div>
          )}
        </AsideSection>

        {ws.prNumber !== undefined && (
          <AsideSection
            persistKey={PERSIST_KEYS.asidePrSection}
            title={t('sourceControl.aside.pullRequest', {
              defaultValue: 'Pull request',
            })}
          >
            <Kv
              k="PR"
              v={`#${ws.prNumber} · ${ws.prStatus ?? 'unknown'}`}
              mono
            />
            {ws.prCiStatus && ws.prCiStatus !== 'none' && (
              <Kv k="CI" v={ws.prCiStatus} />
            )}
            {ws.prUrl && (
              <div className="flex gap-1.5 px-3.5 pt-1.5">
                <GhostButton onClick={() => window.open(ws.prUrl, '_blank')}>
                  <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                  {t('sourceControl.aside.openInGitHub', {
                    defaultValue: 'Open in GitHub',
                  })}
                </GhostButton>
              </div>
            )}
          </AsideSection>
        )}

        <AsideSection
          persistKey={PERSIST_KEYS.asideQuickActions}
          title={t('sourceControl.aside.quickActions', {
            defaultValue: 'Quick actions',
          })}
        >
          <ActRow
            icon={PanelsTopLeft}
            label={t('sourceControl.aside.openWorkspace', {
              defaultValue: 'Open workspace',
            })}
            onClick={() => appNavigation.goToWorkspace(ws.id)}
          />
          <ActRow
            icon={FileCode}
            label={t('sourceControl.aside.openInEditor', {
              defaultValue: 'Open in editor',
            })}
            onClick={openInEditor}
          />
        </AsideSection>
      </div>
    </div>
  );
}
