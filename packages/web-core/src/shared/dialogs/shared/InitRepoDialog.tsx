import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { FolderSimpleIcon, SpinnerIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import type { Repo } from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import type { GithubPublishClient } from '@/shared/lib/githubPublish';
import {
  useCreateOnGithub,
  type LocalRepoDialogResult,
} from '@/shared/hooks/useCreateOnGithub';
import { CreateOnGithubOption } from '@/shared/components/CreateOnGithubOption';

export interface InitRepoDialogProps {
  onBrowseForPath?: (currentPath: string) => Promise<string | null | undefined>;
  initRepo: (params: {
    parentPath: string;
    folderName: string;
  }) => Promise<Repo>;
  github: GithubPublishClient;
  /** Opens Settings > GitHub; the dialog closes first. */
  onOpenGithubSettings?: () => void;
}

/**
 * Initialize a new local git repository, optionally creating it on GitHub
 * too. Resolves with the created repo (even when only the GitHub part
 * failed, so the caller can keep using it and show the failure), or `null`
 * when canceled before anything was created.
 */
const InitRepoDialogImpl = create<InitRepoDialogProps>(
  ({
    onBrowseForPath,
    initRepo,
    github: githubClient,
    onOpenGithubSettings,
  }) => {
    const { t } = useTranslation(['tasks', 'common']);
    const modal = useModal();

    const [name, setName] = useState('');
    const [parentPath, setParentPath] = useState('');
    const [error, setError] = useState<string | null>(null);

    const github = useCreateOnGithub(githubClient, name);
    const created = github.repo;
    const busy = github.submitting;

    const finish = useCallback(
      (result: LocalRepoDialogResult) => {
        modal.resolve(result);
        modal.hide();
      },
      [modal]
    );

    const finishWithoutGithub = useCallback(() => {
      finish(
        created
          ? {
              repo: created,
              published: null,
              githubError: github.publishError,
            }
          : null
      );
    }, [created, finish, github.publishError]);

    const handleBrowseForPath = useCallback(async () => {
      if (!onBrowseForPath) return;
      const selectedPath = await onBrowseForPath(parentPath);
      if (selectedPath) {
        setParentPath(selectedPath);
      }
    }, [onBrowseForPath, parentPath]);

    const handleCreate = useCallback(async () => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError(t('git.createRepo.errors.nameRequired'));
        return;
      }

      setError(null);
      try {
        const outcome = await github.submit(() =>
          initRepo({
            parentPath: parentPath.trim() || '.',
            folderName: trimmedName,
          })
        );
        if (outcome.status === 'done') {
          finish({
            repo: outcome.repo,
            published: outcome.published,
            githubError: null,
          });
        }
        // 'github_failed': stay open; the option shows the error and the
        // primary button retries only the GitHub part.
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('git.createRepo.errors.createFailed')
        );
      }
    }, [finish, github, initRepo, name, parentPath, t]);

    const handleOpenGithubSettings = onOpenGithubSettings
      ? () => {
          finishWithoutGithub();
          onOpenGithubSettings();
        }
      : undefined;

    const handleOpenChange = useCallback(
      (open: boolean) => {
        if (!open && !busy) finishWithoutGithub();
      },
      [busy, finishWithoutGithub]
    );

    const canSubmit =
      name.trim().length > 0 && !busy && github.blocker === null;

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('git.createRepo.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('git.createRepo.dialog.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">
                {t('git.createRepo.form.nameLabel')}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('git.createRepo.form.namePlaceholder')}
                disabled={busy || created !== null}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">
                {t('git.createRepo.form.locationLabel')}
              </label>
              <div className="flex gap-2">
                <Input
                  value={parentPath}
                  onChange={(e) => setParentPath(e.target.value)}
                  placeholder={t('git.createRepo.form.locationPlaceholder')}
                  disabled={busy || created !== null}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleBrowseForPath}
                  disabled={busy || created !== null || !onBrowseForPath}
                >
                  <FolderSimpleIcon className="h-4 w-4" weight="fill" />
                </Button>
              </div>
            </div>

            <CreateOnGithubOption
              github={github}
              fallbackName={name}
              disabled={busy}
              onOpenGithubSettings={handleOpenGithubSettings}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={finishWithoutGithub}
              disabled={busy}
            >
              {created
                ? t('common:githubPublish.continueWithoutGithub')
                : t('common:buttons.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!canSubmit}>
              {busy ? (
                <>
                  <SpinnerIcon className="h-4 w-4 animate-spin mr-2" />
                  {t('git.createRepo.states.creating')}
                </>
              ) : created ? (
                t('common:githubPublish.retry')
              ) : (
                t('git.createRepo.buttons.createRepository')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const InitRepoDialog = defineModal<
  InitRepoDialogProps,
  LocalRepoDialogResult
>(InitRepoDialogImpl);
