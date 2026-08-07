import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  FileCode,
  FileText,
  MessageSquare,
  PanelsTopLeft,
} from 'lucide-react';
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
import {
  PERSIST_KEYS,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaceConflicts } from '@/shared/hooks/useWorkspaceConflicts';
import { useComposerPrefillStore } from '@/features/workspace-chat/model/store/useComposerPrefillStore';
import type { RepoBranchStatus } from 'shared/types';
import type { FleetBranch, AttentionReason } from '../model/useFleetBranches';

// ConflictOp → human label (cherry_pick/revert reach here via `conflict_op`;
// a stopped rebase without conflict markers reports null → 'rebase').
const OP_LABEL: Record<string, string> = {
  rebase: 'rebase',
  merge: 'merge',
  cherry_pick: 'cherry-pick',
  revert: 'revert',
};

function workerCardState(branch: FleetBranch): WorkerCardState {
  // Real attention (conflict/approval/stalled/activity) trumps review — a
  // pending approval blocks progress, whereas 'review' just means the PR is
  // waiting on a human reviewer.
  if (branch.group === 'attention' && branch.attentionReason !== 'review')
    return 'attention';
  if (branch.workspace.hasTaskInReview || branch.attentionReason === 'review')
    return 'review';
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

// Link-look action rows, matching the workspace aside's prefixed-agent
// quick actions (R24): brand-tinted text, 24px rows.
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
      className="flex h-6 w-full cursor-pointer items-center gap-[7px] whitespace-nowrap px-3.5 text-left text-sm text-brand-on-surface hover:bg-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
    >
      <Icon size={13} strokeWidth={1.75} className="flex-none" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * SHELL-SPEC R39: conflict resolution for a repo whose rebase/merge stopped.
 * Continue / Abort hit the existing V6 routes; "Send to worker" preloads the
 * workspace composer (R24 semantics — never auto-sends).
 */
function ConflictsSection({
  branch,
  repo,
  onOpenInEditor,
}: {
  branch: FleetBranch;
  repo: RepoBranchStatus;
  onOpenInEditor: () => void;
}) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const ws = branch.workspace;
  const { continueRebase, isContinuing, abortConflicts, isAborting } =
    useWorkspaceConflicts(ws.id);
  const requestPrefill = useComposerPrefillStore((s) => s.requestPrefill);

  const op = OP_LABEL[repo.conflict_op ?? 'rebase'] ?? 'rebase';
  const files = repo.conflicted_files;
  const canContinue = (repo.conflict_op ?? 'rebase') === 'rebase';

  const sendToWorker = () => {
    const fileList = files.map((f) => `- ${f}`).join('\n');
    const message =
      `Resolve the ${op} conflicts in ${repo.repo_name}: the ${op} onto ` +
      `${repo.target_branch_name} stopped with conflicts` +
      (fileList ? ` in:\n${fileList}` : '.') +
      `\n\nResolve them and continue the ${op}.`;
    requestPrefill(ws.id, message);
    useUiPreferencesStore.getState().openWorkspaceViewTab(ws.id, 'chat');
    appNavigation.goToWorkspace(ws.id);
  };

  return (
    <AsideSection
      persistKey={PERSIST_KEYS.asideConflictsSection}
      title={t('sourceControl.conflicts.title', {
        defaultValue: 'Conflicts · {{op}} onto {{base}}',
        op,
        base: repo.target_branch_name,
      })}
      count={files.length || undefined}
    >
      <div className="mx-3.5 mb-1.5 rounded-md border border-error/40 bg-error/5 px-2.5 py-1.5 text-xs text-normal">
        {files.length > 0
          ? t('sourceControl.conflicts.note', {
              defaultValue:
                '{{count}} conflicted files. The {{op}} stopped — resolve and continue, abort, or send it to the worker.',
              count: files.length,
              op,
            })
          : t('sourceControl.conflicts.noteNoFiles', {
              defaultValue:
                'A {{op}} is in progress on this repo — continue or abort it.',
              op,
            })}
      </div>
      {files.map((file) => (
        <div
          key={file}
          className="flex h-[22px] items-center gap-2 px-3.5 text-sm text-normal"
        >
          <FileText
            className="h-3.5 w-3.5 flex-none text-low"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-code">
            {file}
          </span>
          <span className="flex-none font-mono text-[11px] font-semibold text-error">
            C
          </span>
        </div>
      ))}
      <div className="flex gap-1.5 px-3.5 pt-1.5">
        {canContinue && (
          <GhostButton
            onClick={() => void continueRebase(repo.repo_id)}
            disabled={isContinuing || isAborting}
          >
            {isContinuing
              ? t('sourceControl.conflicts.continuing', {
                  defaultValue: 'Continuing…',
                })
              : t('sourceControl.conflicts.continue', {
                  defaultValue: 'Continue rebase',
                })}
          </GhostButton>
        )}
        <GhostButton
          onClick={() => void abortConflicts(repo.repo_id)}
          disabled={isContinuing || isAborting}
        >
          {isAborting
            ? t('sourceControl.conflicts.aborting', {
                defaultValue: 'Aborting…',
              })
            : t('sourceControl.conflicts.abort', { defaultValue: 'Abort' })}
        </GhostButton>
      </div>
      <div className="pt-1">
        <ActRow
          icon={FileCode}
          label={t('sourceControl.aside.openInEditor', {
            defaultValue: 'Open in editor',
          })}
          onClick={onOpenInEditor}
        />
        <ActRow
          icon={MessageSquare}
          label={t('sourceControl.conflicts.sendToWorker', {
            defaultValue: 'Send to {{worker}}: Resolve merge conflicts',
            worker:
              ws.workerName ??
              t('sourceControl.conflicts.theWorker', {
                defaultValue: 'worker',
              }),
          })}
          onClick={sendToWorker}
        />
      </div>
    </AsideSection>
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

  const conflictRepos = (branch.status ?? []).filter(
    (r) => r.conflicted_files.length > 0 || r.is_rebase_in_progress
  );

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

        {conflictRepos.map((repo) => (
          <ConflictsSection
            key={repo.repo_id}
            branch={branch}
            repo={repo}
            onOpenInEditor={openInEditor}
          />
        ))}

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
