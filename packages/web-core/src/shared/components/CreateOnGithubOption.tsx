import { useTranslation } from 'react-i18next';
import { SpinnerIcon, WarningIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { Input } from '@vibe/ui/components/Input';
import { suggestGithubRepoName } from '@/shared/lib/githubPublish';
import type { CreateOnGithubState } from '@/shared/hooks/useCreateOnGithub';
import { GithubOwnerVisibilityFields } from './GithubOwnerVisibilityFields';

export interface CreateOnGithubOptionProps {
  github: CreateOnGithubState;
  /** Folder name or path the default repository name comes from. */
  fallbackName: string;
  disabled?: boolean;
  /**
   * Opens Settings > GitHub. Without it, the no-session notice only names
   * the place to sign in (e.g. when already inside Settings).
   */
  onOpenGithubSettings?: () => void;
}

/** "Create on GitHub too" checkbox with name, owner and visibility. */
export function CreateOnGithubOption({
  github,
  fallbackName,
  disabled,
  onOpenGithubSettings,
}: CreateOnGithubOptionProps) {
  const { t } = useTranslation('common');
  const { form, setForm } = github;
  // In retry mode the local repo exists: the option stays on (the dialog
  // offers "continue without GitHub" instead of unchecking).
  const locked = disabled || github.submitting || github.repo !== null;
  const fieldsDisabled = disabled || github.submitting;
  const suggestedName = suggestGithubRepoName(fallbackName);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <Checkbox
          id="create-on-github"
          checked={form.enabled}
          onCheckedChange={(enabled) =>
            setForm((prev) => ({ ...prev, enabled }))
          }
          disabled={locked}
          className="mt-0.5"
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-normal">
            {t('githubPublish.checkbox')}
          </span>
          <span className="text-xs text-low">
            {t('githubPublish.checkboxHelper')}
          </span>
        </span>
      </label>

      {form.enabled && (
        <div className="flex flex-col gap-3 pl-6">
          {github.statusLoading ? (
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
                {t('githubPublish.noSession')}
              </p>
              <div className="flex gap-2">
                {onOpenGithubSettings && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenGithubSettings}
                  >
                    {t('githubPublish.openGithubSettings')}
                  </Button>
                )}
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
                  htmlFor="github-publish-name"
                  className="text-sm font-medium text-normal"
                >
                  {t('githubPublish.nameLabel')}
                </label>
                <Input
                  id="github-publish-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder={
                    suggestedName || t('githubPublish.namePlaceholder')
                  }
                  disabled={fieldsDisabled}
                />
                {github.blocker === 'invalid_name' &&
                  (form.name.trim() !== '' || fallbackName.trim() !== '') && (
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
                disabled={fieldsDisabled}
              />
            </>
          )}

          {github.publishError && (
            <div className="flex flex-col gap-1 rounded-sm border border-error/30 bg-error/10 p-2">
              <p className="flex items-start gap-1 text-sm text-error">
                <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {github.repo
                  ? t('githubPublish.localDoneGithubFailed')
                  : t('githubPublish.githubFailed')}
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
      )}
    </div>
  );
}

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
