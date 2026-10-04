import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { useQueryClient } from '@tanstack/react-query';
import { SpinnerIcon, WarningIcon } from '@phosphor-icons/react';
import type { Repo } from 'shared/types';
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
import { defineModal } from '@/shared/lib/modals';
import { localGithubPublishClient } from '@/shared/lib/api';
import { suggestGithubRepoName } from '@/shared/lib/githubPublish';
import { useCreateOnGithub } from '@/shared/hooks/useCreateOnGithub';
import { GithubOwnerVisibilityFields } from '@/shared/components/GithubOwnerVisibilityFields';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { missionKeys } from '../model/useMissions';

export interface ConnectGithubDialogProps {
  /** The mission's repo, already registered locally. */
  repo: Repo;
}

/**
 * Creates the mission's (already registered) repo on GitHub, adds it as
 * `origin` and pushes. Resolves `true` once GitHub reports success.
 *
 * Approval is never unlocked from here: after every attempt the repo's
 * remotes are refetched, and the brief only enables "Approve" when a GitHub
 * remote really shows up. A failed attempt keeps the dialog open; retrying
 * calls the same endpoint, which reuses a GitHub repo it created before
 * (no duplicates) and rolls `origin` back when the push fails.
 */
const ConnectGithubImpl = create<ConnectGithubDialogProps>(({ repo }) => {
  const { t } = useTranslation('common');
  const modal = useModal();
  const queryClient = useQueryClient();
  const fallbackName = repo.name || repo.display_name;
  const github = useCreateOnGithub(localGithubPublishClient, fallbackName);
  const { form, setForm } = github;
  const busy = github.submitting;

  // The option is the whole point of this dialog: always on.
  useEffect(() => {
    setForm((prev) => (prev.enabled ? prev : { ...prev, enabled: true }));
  }, [setForm]);

  const close = useCallback(
    (connected: boolean) => {
      modal.resolve(connected);
      modal.hide();
    },
    [modal]
  );

  const handleConnect = useCallback(async () => {
    const outcome = await github.submit(() => Promise.resolve(repo));
    // Success or not, the remote may have changed: let the brief re-check it.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['repo-remotes', repo.id] }),
      queryClient.invalidateQueries({ queryKey: missionKeys.all }),
    ]);
    if (outcome.status === 'done') close(true);
  }, [close, github, queryClient, repo]);

  const openGithubSettings = useCallback(() => {
    close(false);
    void SettingsDialog.show({ initialSection: 'github' });
  }, [close]);

  const suggestedName = suggestGithubRepoName(fallbackName);
  const canSubmit = form.enabled && !busy && github.blocker === null;

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open && !busy) close(false);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('director.brief.connectGithubDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('director.brief.connectGithubDialog.description', {
              repo: repo.display_name,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-4">
          {github.statusLoading || !form.enabled ? (
            <p className="flex items-center gap-2 text-sm text-low">
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t('githubPublish.checkingSession')}
            </p>
          ) : github.statusError ? (
            <InlineError
              message={t('githubPublish.errors.statusFailed')}
              detail={errorMessage(github.statusError)}
              actionLabel={t('buttons.retry')}
              onAction={() => void github.refetchStatus()}
            />
          ) : github.authenticated === false ? (
            <div className="flex flex-col gap-2 rounded-sm border border-warning/40 bg-warning/10 p-2">
              <p className="text-sm text-normal">
                {t('director.brief.connectGithubDialog.noSession')}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openGithubSettings}
                >
                  {t('githubPublish.openGithubSettings')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void github.refetchStatus()}
                >
                  {t('githubPublish.checkAgain')}
                </Button>
              </div>
            </div>
          ) : github.ownersLoading ? (
            <p className="flex items-center gap-2 text-sm text-low">
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t('githubPublish.loadingOwners')}
            </p>
          ) : github.ownersError || !github.owners ? (
            <InlineError
              message={t('githubPublish.errors.ownersFailed')}
              detail={errorMessage(github.ownersError)}
              actionLabel={t('buttons.retry')}
              onAction={() => void github.refetchOwners()}
            />
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="connect-github-name"
                  className="text-sm font-medium text-normal"
                >
                  {t('githubPublish.nameLabel')}
                </label>
                <Input
                  id="connect-github-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder={
                    suggestedName || t('githubPublish.namePlaceholder')
                  }
                  disabled={busy}
                />
                {github.blocker === 'invalid_name' && (
                  <p className="text-xs text-destructive">
                    {t('githubPublish.errors.invalidName')}
                  </p>
                )}
              </div>
              <GithubOwnerVisibilityFields
                owners={github.owners}
                owner={form.owner}
                visibility={form.visibility}
                onOwnerChange={(owner) =>
                  setForm((prev) => ({ ...prev, owner }))
                }
                onVisibilityChange={(visibility) =>
                  setForm((prev) => ({ ...prev, visibility }))
                }
                disabled={busy}
              />
            </>
          )}

          {github.publishError && (
            <div className="flex flex-col gap-1 rounded-sm border border-error/30 bg-error/10 p-2">
              <p className="flex items-start gap-1 text-sm text-error">
                <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {t('director.brief.connectGithubDialog.failed')}
              </p>
              <p className="text-xs text-error">
                {t(`githubPublish.errors.${github.publishError.kind}`)}
              </p>
              <p className="text-xs text-low break-words">
                {github.publishError.message}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close(false)}
            disabled={busy}
          >
            {t('buttons.cancel')}
          </Button>
          <Button onClick={() => void handleConnect()} disabled={!canSubmit}>
            {busy ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin mr-2" />
                {t('director.brief.connectGithubDialog.connecting')}
              </>
            ) : github.publishError ? (
              t('githubPublish.retry')
            ) : (
              t('director.brief.connectGithubDialog.confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const ConnectGithubDialog = defineModal<
  ConnectGithubDialogProps,
  boolean
>(ConnectGithubImpl);

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function InlineError({
  message,
  detail,
  actionLabel,
  onAction,
}: {
  message: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm text-destructive">{message}</p>
      {detail && <p className="text-xs text-low break-words">{detail}</p>}
      <Button type="button" size="sm" variant="outline" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
