import { useTranslation } from 'react-i18next';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Loader } from '@vibe/ui/components/Loader';
import GitOperations from '@/shared/components/tasks/Toolbar/GitOperations';
import { useWorkspaceWithSession } from '@/shared/hooks/useWorkspace';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useWorkspaceExecution } from '@/shared/hooks/useWorkspaceExecution';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import {
  GitOperationsProvider,
  useGitOperationsError,
} from '@/shared/hooks/GitOperationsContext';
import type { Merge, RepoBranchStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import { workspacesApi } from '@/shared/lib/api';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';

export interface GitActionsDialogProps {
  workspaceId: string;
}

interface GitActionsDialogContentProps {
  attempt: WorkspaceWithSession;
}

function GitActionsDialogContent({ attempt }: GitActionsDialogContentProps) {
  const { t } = useTranslation('tasks');
  const { data: branchStatus, error: branchStatusError } = useBranchStatus(
    attempt.id
  );
  const { isAttemptRunning } = useWorkspaceExecution(attempt.id);
  const { error: gitError } = useGitOperationsError();
  const { repos, selectedRepoId } = useWorkspaceRepo(attempt.id);

  const selectedRepoStatus = (() => {
    const repoId = selectedRepoId ?? repos[0]?.id;
    return branchStatus?.find((r) => r.repo_id === repoId);
  })();

  const mergedPR = selectedRepoStatus?.merges?.find(
    (m: Merge) => m.type === 'pr' && m.pr_info?.status === 'merged'
  );

  const openPR = selectedRepoStatus?.merges?.find(
    (m: Merge) => m.type === 'pr' && m.pr_info?.status === 'open'
  );
  const openPRMergeable =
    openPR?.type === 'pr'
      ? ((
          openPR.pr_info as typeof openPR.pr_info & {
            mergeable?: string | null;
          }
        ).mergeable ?? undefined)
      : undefined;

  // `pr_ci_status` is populated by the branch-status handler from the cached
  // PR check rollup. Shim until `pnpm run generate-types` runs.
  const prCiStatus =
    (
      selectedRepoStatus as
        | (RepoBranchStatus & { pr_ci_status?: string | null })
        | undefined
    )?.pr_ci_status ?? undefined;

  // Only fetch the comment count when there's an open PR — the endpoint
  // relies on it and would return `no_pr_attached` otherwise.
  const { data: prCommentsCount } = useQuery({
    queryKey: [
      'workspace-pr-comments-count',
      attempt.id,
      selectedRepoId,
      openPR?.type === 'pr' ? openPR.pr_info.number : null,
    ],
    queryFn: async () => {
      if (!selectedRepoId) return 0;
      const res = await workspacesApi.getPrComments(attempt.id, selectedRepoId);
      return res.comments.length;
    },
    enabled: !!openPR && !!selectedRepoId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="space-y-4">
      {mergedPR && mergedPR.type === 'pr' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {t('git.actions.prMerged', {
              number: mergedPR.pr_info.number || '',
            })}
          </span>
          {mergedPR.pr_info.url && (
            <a
              href={mergedPR.pr_info.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {t('git.pr.number', {
                number: Number(mergedPR.pr_info.number),
              })}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
      {gitError && (
        <div className="p-3 border border-destructive rounded text-destructive text-sm">
          {gitError}
        </div>
      )}
      <GitOperations
        selectedAttempt={attempt}
        branchStatus={branchStatus ?? null}
        branchStatusError={branchStatusError}
        isAttemptRunning={isAttemptRunning}
        selectedBranch={selectedRepoStatus?.target_branch_name ?? null}
        layout="vertical"
        prMergeable={openPRMergeable}
        prCiStatus={prCiStatus}
        prCommentsCount={prCommentsCount}
      />
    </div>
  );
}

const GitActionsDialogImpl = create<GitActionsDialogProps>(
  ({ workspaceId }) => {
    const modal = useModal();
    const { t } = useTranslation('tasks');

    const { data: attempt } = useWorkspaceWithSession(workspaceId);

    const handleOpenChange = (open: boolean) => {
      if (!open) {
        modal.hide();
      }
    };

    const isLoading = !attempt;

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('git.actions.title')}</DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="py-8">
              <Loader size={24} />
            </div>
          ) : (
            <GitOperationsProvider workspaceId={attempt.id}>
              <ExecutionProcessesProvider
                key={attempt.id}
                sessionId={attempt.session?.id}
              >
                <GitActionsDialogContent attempt={attempt} />
              </ExecutionProcessesProvider>
            </GitOperationsProvider>
          )}
        </DialogContent>
      </Dialog>
    );
  }
);

export const GitActionsDialog = defineModal<GitActionsDialogProps, void>(
  GitActionsDialogImpl
);
