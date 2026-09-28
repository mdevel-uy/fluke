import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowUp,
  ChevronDown,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react';
import type { Merge, RepoWithTargetBranch, Workspace } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { workersApi, workspacesApi } from '@/shared/lib/api';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { usePush } from '@/shared/hooks/usePush';
import { useActions } from '@/shared/hooks/useActions';
import { Actions } from '@/shared/actions';
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import {
  PERSIST_KEYS,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { useComposerPrefillStore } from '@/features/workspace-chat/model/store/useComposerPrefillStore';
import {
  useWorkers,
  useAllWorkerTasks,
} from '@/features/sprint/model/useWorkers';
import { useWorkerTaskIndex } from '@/features/workers/model/workerTaskInfo';
import { taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import { reRequestReviewErrorKey } from '@/features/sprint/model/reRequestReviewError';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  reviewGate,
  reviewGateHint,
  reviewGateLabel,
  reviewGateToneClass,
} from '@vibe/ui/lib/reviewGate';
import { FileTreeContainer } from './FileTreeContainer';
import { WorkerDetailCard } from '@/shared/components/ui-new/aside/WorkerDetailCard';
import {
  AsideSection,
  GhostButton,
  Kv,
  StatusDot,
  formatElapsed,
  type DotTone,
} from '@/shared/components/ui-new/aside/primitives';

// SHELL-SPEC R18-R24: the aside is a strict master-detail of the selected
// workspace — worker card, Issue, Changes, Git, Pull request and Quick
// actions, all scoped to that workspace's branch. No global sections.

export interface RightSidebarProps {
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
}

type PushState = 'idle' | 'pending' | 'success' | 'error';

interface RepoGitInfo {
  repoId: string;
  repoName: string;
  targetBranch: string;
  commitsAhead: number;
  commitsBehind: number;
  remoteCommitsAhead: number;
  headOid: string | null;
  openPr: { number: number; url: string } | null;
}

const CI_TONE: Record<string, DotTone> = {
  passing: 'ok',
  failing: 'err',
  pending: 'run',
};

export const RightSidebar = memo(function RightSidebar({
  selectedWorkspace,
  repos,
}: RightSidebarProps) {
  const { t } = useTranslation('common');
  const workspaceId = selectedWorkspace?.id;

  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const sidebarWs = useMemo(() => {
    if (!workspaceId) return undefined;
    return (
      activeWorkspaces.find((ws) => ws.id === workspaceId) ??
      archivedWorkspaces.find((ws) => ws.id === workspaceId)
    );
  }, [workspaceId, activeWorkspaces, archivedWorkspaces]);

  // Worker identity + task backing this workspace (R19/R20, R31: the worker
  // has a name; the model is an attribute).
  const { data: workers } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const taskIndex = useWorkerTaskIndex(workers, tasks);
  const task = workspaceId
    ? taskIndex.taskByWorkspaceId.get(workspaceId)
    : undefined;
  const worker = task ? taskIndex.workerById.get(task.worker_id) : undefined;

  const appNavigation = useAppNavigation();

  // In-progress reviewer worker task pointing at this workspace's PR. A
  // reviewer task's issue_number holds the PR number (#585), while the
  // developer task's holds the issue it implements (#571) — so match on the
  // workspace's PR number. When present, the REVIEW badge becomes a shortcut
  // to that reviewer's workspace so you can watch the review as it happens.
  const prNumber = sidebarWs?.prNumber;
  const activeReviewerTask = useMemo(() => {
    if (prNumber == null) return undefined;
    return tasks.find((t) => {
      const w = taskIndex.workerById.get(t.worker_id);
      return (
        w?.role === 'reviewer' &&
        t.issue_number === prNumber &&
        t.status === 'in_progress' &&
        t.workspace_id != null
      );
    });
  }, [tasks, prNumber, taskIndex]);

  const isRunning = !!sidebarWs?.isRunning;
  // `isFinalizing` covers the orchestrator's PR-publishing window
  // (push + adopt/create + on_pr_open) that briefly follows the agent stopping
  // while the DB task is still `in_progress` — without it the aside flashes
  // "stalled" between agent-done and task→in_review (issue #494).
  const hasStalledTask =
    task?.status === 'in_progress' &&
    !isRunning &&
    !sidebarWs?.hasPendingApproval &&
    !sidebarWs?.hasTaskInReview &&
    !sidebarWs?.isFinalizing &&
    sidebarWs?.latestProcessStatus !== 'running';
  const needsAttention =
    !!sidebarWs?.hasPendingApproval ||
    hasStalledTask ||
    sidebarWs?.latestProcessStatus === 'failed';
  const attentionLabel = sidebarWs?.hasPendingApproval
    ? t('workspaces.aside.waitingForApproval', {
        defaultValue: 'Waiting for your approval',
      })
    : sidebarWs?.latestProcessStatus === 'failed'
      ? t('workspaces.aside.lastRunFailed', {
          defaultValue: 'Last run failed',
        })
      : t('workspaces.aside.stalled', {
          defaultValue: 'Stalled — task in progress, agent stopped',
        });
  const cardState = isRunning
    ? 'running'
    : needsAttention
      ? 'attention'
      : sidebarWs?.hasTaskInReview
        ? 'review'
        : 'idle';

  const contextPct = useMemo(() => {
    const usage = sidebarWs?.contextUsage;
    if (!usage || !usage.contextWindow) return undefined;
    return Math.min(100, (usage.totalTokens / usage.contextWindow) * 100);
  }, [sidebarWs?.contextUsage]);

  // Stop / focus chat
  const stopMutation = useMutation({
    mutationKey: ['asideStopExecution', workspaceId],
    mutationFn: () => workspacesApi.stop(workspaceId ?? ''),
    onError: (err) => {
      ConfirmDialog.show({
        title: t('workspaces.aside.stopFailedTitle', {
          defaultValue: 'Stop failed',
        }),
        message:
          err instanceof Error
            ? err.message
            : t('workspaces.aside.stopFailed', {
                defaultValue: 'Failed to stop the agent',
              }),
        confirmText: 'OK',
        showCancelButton: false,
        variant: 'destructive',
      });
    },
  });
  const handleStop = useCallback(() => {
    if (!workspaceId || stopMutation.isPending) return;
    stopMutation.mutate();
  }, [workspaceId, stopMutation]);

  const openWorkspaceViewTab = useUiPreferencesStore(
    (s) => s.openWorkspaceViewTab
  );
  const focusChat = useCallback(() => {
    if (!workspaceId) return;
    openWorkspaceViewTab(workspaceId, 'chat');
  }, [workspaceId, openWorkspaceViewTab]);

  // Quick actions (R24): preload the composer with the preset draft, surface
  // the chat tab, and auto-send so the click alone kicks off the worker.
  const requestPrefill = useComposerPrefillStore((s) => s.requestPrefill);
  const handleQuickAction = useCallback(
    (message: string) => {
      if (!workspaceId) return;
      requestPrefill(workspaceId, message, { autoSend: true });
      openWorkspaceViewTab(workspaceId, 'chat');
    },
    [workspaceId, requestPrefill, openWorkspaceViewTab]
  );

  // Changes scoped to the selected workspace (diff store is master-detail
  // of the active workspace already).
  const diffs = useDiffs();

  // Git per repo (R22) from branch status, summary PR as fast fallback.
  const { data: branchStatus } = useBranchStatus(workspaceId);
  const repoGitInfos: RepoGitInfo[] = useMemo(
    () =>
      repos.map((repo) => {
        const status = branchStatus?.find((s) => s.repo_id === repo.id);
        let openPr: RepoGitInfo['openPr'] = null;
        if (status?.merges) {
          const pr = status.merges.find(
            (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
          );
          if (pr && pr.type === 'pr') {
            openPr = { number: Number(pr.pr_info.number), url: pr.pr_info.url };
          }
        } else if (
          sidebarWs?.prStatus === 'open' &&
          sidebarWs.prNumber &&
          sidebarWs.prUrl
        ) {
          openPr = { number: sidebarWs.prNumber, url: sidebarWs.prUrl };
        }
        return {
          repoId: repo.id,
          repoName: repo.display_name || repo.name,
          targetBranch: repo.target_branch || 'main',
          commitsAhead: status?.commits_ahead ?? 0,
          commitsBehind: status?.commits_behind ?? 0,
          remoteCommitsAhead: status?.remote_commits_ahead ?? 0,
          headOid: status?.head_oid ?? null,
          openPr,
        };
      }),
    [repos, branchStatus, sidebarWs]
  );
  const firstOpenPr = useMemo(
    () => repoGitInfos.find((r) => r.openPr)?.openPr ?? null,
    [repoGitInfos]
  );

  // Push with per-repo state (same flow as GitPanelContainer, slimmed)
  const [pushStates, setPushStates] = useState<Record<string, PushState>>({});
  const currentPushRepoRef = useRef<string | null>(null);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setPushStates({});
    currentPushRepoRef.current = null;
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    return () => {
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, [workspaceId]);

  const pushMutation = usePush(
    workspaceId,
    () => {
      const repoId = currentPushRepoRef.current;
      if (!repoId) return;
      setPushStates((prev) => ({ ...prev, [repoId]: 'success' }));
      resetTimeoutRef.current = setTimeout(() => {
        setPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
      }, 2000);
    },
    async (err, errorData) => {
      const repoId = currentPushRepoRef.current;
      if (!repoId) return;
      if (errorData?.type === 'force_push_required' && workspaceId) {
        setPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
        await ForcePushDialog.show({ workspaceId, repoId });
        return;
      }
      setPushStates((prev) => ({ ...prev, [repoId]: 'error' }));
      ConfirmDialog.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to push changes',
        confirmText: 'OK',
        showCancelButton: false,
        variant: 'destructive',
      });
      resetTimeoutRef.current = setTimeout(() => {
        setPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
      }, 3000);
    }
  );
  const handlePush = useCallback(
    (repoId: string) => {
      if (pushStates[repoId] === 'pending') return;
      currentPushRepoRef.current = repoId;
      setPushStates((prev) => ({ ...prev, [repoId]: 'pending' }));
      pushMutation.mutate({ repo_id: repoId });
    },
    [pushStates, pushMutation]
  );

  const { executeAction } = useActions();
  const handleCreatePr = useCallback(
    (repoId: string) => {
      if (!workspaceId) return;
      void executeAction(Actions.GitCreatePR, workspaceId, repoId);
    },
    [workspaceId, executeAction]
  );

  // Request review: dispatches the internal reviewer worker (not GitHub's
  // request-review) — only available for worker-task-backed workspaces.
  const reviewMutation = useMutation({
    mutationFn: () => {
      if (!task) return Promise.resolve();
      return workersApi.reRequestReview(task.worker_id, task.id);
    },
    onError: (err) => {
      ConfirmDialog.show({
        title: t('workspaces.aside.requestReviewFailedTitle', {
          defaultValue: 'Request review failed',
        }),
        message: t(reRequestReviewErrorKey(err), {
          message: err instanceof Error ? err.message : String(err),
        }),
        confirmText: 'OK',
        showCancelButton: false,
        variant: 'destructive',
      });
    },
  });

  // Address requested changes: sends the author the same remediation prompt
  // the orchestrator uses (reviewer comments inlined). The manual path once
  // the loop stops fixing on its own — e.g. after the review rounds ran out.
  const addressChangesMutation = useMutation({
    mutationFn: () => {
      if (!task) return Promise.reject(new Error('No worker task'));
      return workersApi.getRemediationPrompt(task.worker_id, task.id);
    },
    onSuccess: (prompt) => handleQuickAction(prompt),
    onError: (err) => {
      ConfirmDialog.show({
        title: t('workspaces.aside.addressChangesFailedTitle', {
          defaultValue: 'Could not load the requested changes',
        }),
        message: err instanceof Error ? err.message : 'Unknown error',
        confirmText: 'OK',
        showCancelButton: false,
        variant: 'destructive',
      });
    },
  });

  if (!selectedWorkspace) {
    return (
      <div className="h-full bg-md-surface-container-low">
        <div className="px-3.5 py-4 text-sm text-low">
          {t('workspaces.aside.emptyHint', {
            defaultValue:
              'Select a workspace to see its worker, changes and git detail.',
          })}
        </div>
      </div>
    );
  }

  const ciStatus = sidebarWs?.prCiStatus;
  const ciTone: DotTone = (ciStatus && CI_TONE[ciStatus]) || 'idle';
  const ciLabel =
    ciStatus === 'passing'
      ? t('workspaces.aside.ciPassing', { defaultValue: 'passing' })
      : ciStatus === 'failing'
        ? t('workspaces.aside.ciFailing', { defaultValue: 'failing' })
        : ciStatus === 'pending'
          ? t('workspaces.aside.ciPending', { defaultValue: 'running' })
          : t('workspaces.aside.ciNone', { defaultValue: 'no checks' });

  const reviewResult = task?.review_result;
  const gate = reviewGate({
    reviewResult,
    reviewActivity: sidebarWs?.prReviewActivity,
    ciStatus,
    reviewerWorking: !!activeReviewerTask,
    authorWorking: isRunning,
    roundsExhausted: sidebarWs?.prReviewRoundsExhausted,
  });
  const gateHint = reviewGateHint(gate, t);

  const quickActions: { label: string; message: string; icon: ReactIcon }[] = [
    {
      label: t('workspaces.aside.quickAddressComments', {
        defaultValue: 'Address PR comments',
      }),
      message: t('workspaces.aside.quickAddressCommentsMsg', {
        defaultValue: 'Address the review comments on the pull request.',
      }),
      icon: MessageSquare,
    },
    {
      label: t('workspaces.aside.quickResolveConflicts', {
        defaultValue: 'Resolve merge conflicts',
      }),
      message: t('workspaces.aside.quickResolveConflictsMsg', {
        defaultValue: 'Resolve the merge conflicts with the target branch.',
      }),
      icon: GitMerge,
    },
    {
      label: t('workspaces.aside.quickFixCi', {
        defaultValue: 'Fix CI failures',
      }),
      message: t('workspaces.aside.quickFixCiMsg', {
        defaultValue: 'Fix the failing CI checks on the pull request.',
      }),
      icon: TriangleAlert,
    },
  ];

  return (
    <div className="flex h-full flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={selectedWorkspace.name ?? selectedWorkspace.branch ?? ''}
          collapsible={false}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* R19 · Worker card */}
        <WorkerDetailCard
          noAgent={!task && !isRunning && !sidebarWs?.latestProcessStatus}
          name={worker?.name}
          role={worker?.role ?? undefined}
          model={worker?.model ?? undefined}
          lastActivity={
            sidebarWs?.latestActivity ??
            (sidebarWs?.latestProcessCompletedAt
              ? `${formatElapsed(sidebarWs.latestProcessCompletedAt)} ago`
              : undefined)
          }
          contextPct={contextPct}
          state={cardState}
          attentionLabel={needsAttention ? attentionLabel : undefined}
          elapsed={
            isRunning
              ? formatElapsed(sidebarWs?.latestProcessStartedAt)
              : undefined
          }
          onStop={handleStop}
          isStopping={stopMutation.isPending}
          onStart={focusChat}
        />

        {/* R20 · Issue */}
        <AsideSection
          persistKey={PERSIST_KEYS.asideIssueSection}
          title={t('workspaces.aside.issue', { defaultValue: 'Issue' })}
        >
          <Kv
            k={t('workspaces.aside.issue', { defaultValue: 'Issue' })}
            v={
              task
                ? [
                    task.issue_number != null ? `#${task.issue_number}` : null,
                    taskDisplayTitle(task),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '—'
            }
          />
          <Kv
            k={t('workspaces.aside.state', { defaultValue: 'State' })}
            v={
              needsAttention
                ? t('workspaces.aside.needsAttention', {
                    defaultValue: 'Needs attention',
                  })
                : isRunning
                  ? t('workspaces.aside.inProgress', {
                      defaultValue: 'In progress',
                    })
                  : (task?.status ??
                    t('workspaces.aside.idle', { defaultValue: 'Idle' }))
            }
          />
          <Kv
            k={t('workspaces.aside.worker', { defaultValue: 'Worker' })}
            v={worker?.name ?? '—'}
          />
        </AsideSection>

        {/* R21 · Changes (only when there is work) */}
        {diffs.length > 0 && (
          <AsideSection
            persistKey={PERSIST_KEYS.asideChangesSection}
            title={t('workspaces.aside.changes', { defaultValue: 'Changes' })}
            count={diffs.length}
          >
            <div className="max-h-[40vh] overflow-y-auto">
              <FileTreeContainer
                key={selectedWorkspace.id}
                workspaceId={selectedWorkspace.id}
                diffs={diffs}
                className=""
              />
            </div>
          </AsideSection>
        )}

        {/* R22 · Git */}
        <AsideSection
          persistKey={PERSIST_KEYS.asideGitSection}
          title={t('workspaces.aside.git', { defaultValue: 'Git' })}
        >
          {repoGitInfos.map((repo) => (
            <div key={repo.repoId} className="pb-1">
              {repoGitInfos.length > 1 && (
                <div className="px-3.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-low">
                  {repo.repoName}
                </div>
              )}
              <Kv
                k={t('workspaces.aside.branch', { defaultValue: 'Branch' })}
                v={selectedWorkspace.branch ?? '—'}
                mono
              />
              <Kv
                k={t('workspaces.aside.aheadBehind', {
                  defaultValue: 'Ahead / behind',
                })}
                v={`+${repo.commitsAhead} / ${repo.commitsBehind}`}
                mono
              />
              {repo.headOid && (
                <Kv
                  k={t('workspaces.aside.lastCommit', {
                    defaultValue: 'Last commit',
                  })}
                  v={repo.headOid.slice(0, 7)}
                  mono
                />
              )}
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1 pt-[7px]">
                {repo.remoteCommitsAhead > 0 && (
                  <GhostButton
                    onClick={() => handlePush(repo.repoId)}
                    disabled={pushStates[repo.repoId] === 'pending'}
                  >
                    <ArrowUp size={12} strokeWidth={1.75} />
                    {pushStates[repo.repoId] === 'pending'
                      ? t('workspaces.aside.pushing', {
                          defaultValue: 'Pushing…',
                        })
                      : pushStates[repo.repoId] === 'success'
                        ? t('workspaces.aside.pushed', {
                            defaultValue: 'Pushed',
                          })
                        : t('workspaces.aside.pushN', {
                            defaultValue: 'Push +{{count}}',
                            count: repo.remoteCommitsAhead,
                          })}
                  </GhostButton>
                )}
                {!repo.openPr && (
                  <GhostButton onClick={() => handleCreatePr(repo.repoId)}>
                    <GitPullRequest size={12} strokeWidth={1.75} />
                    {t('workspaces.aside.createPr', {
                      defaultValue: 'Create pull request',
                    })}
                  </GhostButton>
                )}
              </div>
            </div>
          ))}
        </AsideSection>

        {/* R23 · Pull request (only when one exists) */}
        {firstOpenPr && (
          <AsideSection
            persistKey={PERSIST_KEYS.asidePrSection}
            title={t('workspaces.aside.pullRequest', {
              defaultValue: 'Pull request',
            })}
          >
            <Kv
              k={t('workspaces.aside.pr', { defaultValue: 'PR' })}
              v={`#${firstOpenPr.number} · ${t('workspaces.aside.prOpen', {
                defaultValue: 'Open',
              })}`}
              mono
            />
            <div className="flex items-center gap-3 px-3.5 py-[3px] text-sm text-normal">
              <span className="w-[46px] flex-none text-[10px] font-semibold uppercase tracking-wider text-low">
                {t('workspaces.aside.ci', { defaultValue: 'CI' })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={ciTone} />
                {ciLabel}
              </span>
            </div>
            <div className="flex items-center gap-3 px-3.5 py-[3px] text-sm">
              <span className="w-[46px] flex-none text-[10px] font-semibold uppercase tracking-wider text-low">
                {t('workspaces.aside.review', { defaultValue: 'Review' })}
              </span>
              {gate === 'reviewing' && activeReviewerTask?.workspace_id ? (
                <button
                  type="button"
                  onClick={() =>
                    appNavigation.goToWorkspace(
                      activeReviewerTask.workspace_id as string
                    )
                  }
                  className={cn(
                    'rounded-full border px-[7px] text-[10px] font-semibold leading-4',
                    'animate-pulse border-info/45 text-info',
                    'cursor-pointer hover:bg-info/10',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                  )}
                >
                  {t('workspaces.aside.reviewerWorking', {
                    defaultValue: 'Reviewer working...',
                  })}
                </button>
              ) : (
                <span
                  className={cn(
                    'rounded-full border px-[7px] text-[10px] font-semibold leading-4',
                    reviewGateToneClass(gate)
                  )}
                >
                  {reviewGateLabel(gate, t)}
                </span>
              )}
            </div>
            {gateHint && (
              <p className="px-3.5 pb-0.5 pl-[70px] text-xs leading-snug text-low">
                {gateHint}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 px-3.5 pb-1 pt-[7px]">
              {task && (
                <GhostButton
                  onClick={() => reviewMutation.mutate()}
                  disabled={reviewMutation.isPending}
                >
                  {reviewMutation.isPending
                    ? t('workspaces.aside.requestingReview', {
                        defaultValue: 'Requesting…',
                      })
                    : t('workspaces.aside.requestReview', {
                        defaultValue: 'Request review',
                      })}
                  <ChevronDown size={12} strokeWidth={1.75} />
                </GhostButton>
              )}
              <GhostButton
                onClick={() =>
                  window.open(firstOpenPr.url, '_blank', 'noopener,noreferrer')
                }
              >
                <ExternalLink size={12} strokeWidth={1.75} />
                {t('workspaces.aside.openInGitHub', {
                  defaultValue: 'Open in GitHub',
                })}
              </GhostButton>
            </div>
          </AsideSection>
        )}

        {/* R24 · Quick actions (preset messages → composer draft) */}
        {(task || firstOpenPr) && (
          <AsideSection
            persistKey={PERSIST_KEYS.asideQuickActions}
            title={t('workspaces.aside.quickActions', {
              defaultValue: 'Quick actions',
            })}
          >
            {task &&
              (gate === 'changes_requested' || gate === 'escalated') && (
                <button
                  type="button"
                  onClick={() => addressChangesMutation.mutate()}
                  disabled={addressChangesMutation.isPending}
                  className={cn(
                    'flex h-6 w-full items-center gap-[7px] px-3.5 text-left text-sm font-medium text-brand-on-surface',
                    'hover:bg-secondary cursor-pointer whitespace-nowrap disabled:opacity-60',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                  )}
                >
                  <GitPullRequest
                    size={13}
                    strokeWidth={1.75}
                    className="flex-none"
                  />
                  <span className="truncate">
                    {addressChangesMutation.isPending
                      ? t('workspaces.aside.addressChangesLoading', {
                          defaultValue: 'Loading review…',
                        })
                      : t('workspaces.aside.addressChanges', {
                          defaultValue: 'Address requested changes',
                        })}
                  </span>
                </button>
              )}
            {quickActions.map(({ label, message, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => handleQuickAction(message)}
                className={cn(
                  'flex h-6 w-full items-center gap-[7px] px-3.5 text-left text-sm text-brand-on-surface',
                  'hover:bg-secondary cursor-pointer whitespace-nowrap',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                )}
              >
                <Icon size={13} strokeWidth={1.75} className="flex-none" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </AsideSection>
        )}
      </div>
    </div>
  );
});

type ReactIcon = typeof MessageSquare;
