import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Textarea } from '@vibe/ui/components/Textarea';
import { Label } from '@vibe/ui/components/Label';
import { Alert } from '@vibe/ui/components/Alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal } from '@/shared/lib/modals';
import { projectIssuesApi } from '@/shared/lib/api';
import type { ProjectIssue } from '@/features/issues/types';
import { buildAssignToAgentPrompt } from './assignToAgentPrompt';
import { setCreateModeSeedState } from '@/features/create-mode/model/createModeSeedStore';
import { buildWorkspaceCreateInitialState } from '@/shared/lib/workspaceCreateState';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

export interface AssignToAgentDialogProps {
  issue: ProjectIssue;
  projectId: string;
}

export type AssignToAgentResult = 'created' | 'canceled';

const AssignToAgentDialogImpl = create<AssignToAgentDialogProps>(
  ({ issue, projectId }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const appNavigation = useAppNavigation();

    const [prompt, setPrompt] = useState(() => buildAssignToAgentPrompt(issue));
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [repoLoadError, setRepoLoadError] = useState(false);
    const [preferredRepos, setPreferredRepos] = useState<
      Array<{ repo_id: string; target_branch: string | null }>
    >([]);

    useEffect(() => {
      let cancelled = false;
      setLoadingRepos(true);
      setRepoLoadError(false);
      projectIssuesApi
        .repos(projectId)
        .then((repos) => {
          if (cancelled) return;
          setPreferredRepos(
            repos.map((repo) => ({
              repo_id: repo.id,
              target_branch: repo.default_target_branch ?? null,
            }))
          );
        })
        .catch(() => {
          if (cancelled) return;
          setRepoLoadError(true);
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingRepos(false);
        });

      return () => {
        cancelled = true;
      };
    }, [projectId]);

    const handleCancel = () => {
      modal.resolve('canceled' as AssignToAgentResult);
      modal.hide();
    };

    const handleConfirm = () => {
      const trimmed = prompt.trim();
      if (!trimmed) return;

      const createState = buildWorkspaceCreateInitialState({
        prompt: trimmed,
        defaults:
          preferredRepos.length > 0 ? { preferredRepos } : null,
      });
      setCreateModeSeedState(createState);
      appNavigation.goToWorkspacesCreate();
      modal.resolve('created' as AssignToAgentResult);
      modal.hide();
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) handleCancel();
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>
              {t('issues.assignDialog.title', { number: issue.number })}
            </DialogTitle>
            <DialogDescription>
              {t('issues.assignDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="assign-to-agent-prompt">
                {t('issues.assignDialog.promptLabel')}
              </Label>
              <Textarea
                id="assign-to-agent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={12}
                className="mt-1 font-mono text-sm"
                autoFocus
              />
            </div>
            {loadingRepos && (
              <p className="text-xs text-muted-foreground">
                {t('issues.assignDialog.loadingRepos')}
              </p>
            )}
            {repoLoadError && (
              <Alert variant="destructive">
                {t('issues.assignDialog.reposError')}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              {t('issues.assignDialog.cancel')}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={loadingRepos || !prompt.trim()}
            >
              {loadingRepos && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('issues.assignDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const AssignToAgentDialog = defineModal<
  AssignToAgentDialogProps,
  AssignToAgentResult
>(AssignToAgentDialogImpl);
