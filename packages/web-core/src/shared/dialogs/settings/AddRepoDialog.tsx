import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  FolderSimpleIcon,
  GithubLogoIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
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
import {
  ButtonGroup,
  ButtonGroupItem,
} from '@vibe/ui/components/IconButtonGroup';
import { githubApi, ApiError } from '@/shared/lib/api';
import { defineModal } from '@/shared/lib/modals';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import type { GitHubRepoSummary } from 'shared/types';

export interface AddRepoDialogProps {
  title?: string;
  description?: string;
}

export type AddRepoDialogResult = { path: string } | null;

type Mode = 'folder' | 'github';

const AddRepoDialogImpl = create<AddRepoDialogProps>(
  ({ title, description }) => {
    const modal = useModal();
    const { t } = useTranslation(['settings', 'common']);

    const [mode, setMode] = useState<Mode>('folder');

    const [manualPath, setManualPath] = useState('');
    const [folderError, setFolderError] = useState<string | null>(null);

    const handleBrowse = useCallback(async () => {
      const picked = await FolderPickerDialog.show({
        value: manualPath,
        title: t('settings.repos.addRepo.dialogTitle'),
        description: t('settings.repos.addRepo.dialogDescription'),
      });
      if (picked) {
        setManualPath(picked);
      }
    }, [manualPath, t]);

    const handleSubmitFolder = useCallback(() => {
      const trimmed = manualPath.trim();
      if (!trimmed) {
        setFolderError(t('settings.repos.addRepo.errors.pathRequired'));
        return;
      }
      modal.resolve({ path: trimmed } as AddRepoDialogResult);
      modal.hide();
    }, [manualPath, modal, t]);

    const [search, setSearch] = useState('');
    const [cloning, setCloning] = useState<string | null>(null);
    const [ghError, setGhError] = useState<string | null>(null);

    const {
      data: repos,
      isLoading: reposLoading,
      error: reposError,
      refetch: refetchRepos,
    } = useQuery({
      queryKey: ['github', 'repos'],
      queryFn: () => githubApi.listRepos(),
      enabled: mode === 'github',
      staleTime: 60_000,
    });

    const filteredRepos = useMemo<GitHubRepoSummary[]>(() => {
      const list = repos ?? [];
      const q = search.trim().toLowerCase();
      if (!q) return list;
      return list.filter((r) => r.nameWithOwner.toLowerCase().includes(q));
    }, [repos, search]);

    const handleCloneRepo = useCallback(
      async (repo: GitHubRepoSummary) => {
        if (cloning) return;
        setCloning(repo.nameWithOwner);
        setGhError(null);
        try {
          const result = await githubApi.clone({
            name_with_owner: repo.nameWithOwner,
          });
          modal.resolve({ path: result.path } as AddRepoDialogResult);
          modal.hide();
        } catch (err) {
          setGhError(
            err instanceof ApiError || err instanceof Error
              ? err.message
              : t('settings.repos.addRepo.errors.cloneFailed')
          );
        } finally {
          setCloning(null);
        }
      },
      [cloning, modal, t]
    );

    const handleCancel = useCallback(() => {
      if (cloning) return;
      modal.resolve(null);
      modal.hide();
    }, [cloning, modal]);

    const handleOpenChange = useCallback(
      (open: boolean) => {
        if (!open) handleCancel();
      },
      [handleCancel]
    );

    const reposErrorMessage =
      reposError instanceof ApiError && reposError.status === 401
        ? t('settings.repos.addRepo.github.notAuthenticated')
        : reposError instanceof Error
          ? reposError.message
          : reposError
            ? t('settings.repos.addRepo.errors.listFailed')
            : null;

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {title ?? t('settings.repos.addRepo.dialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {description ?? t('settings.repos.addRepo.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <ButtonGroup className="self-start">
              <ButtonGroupItem
                icon={FolderSimpleIcon}
                active={mode === 'folder'}
                onClick={() => setMode('folder')}
                disabled={!!cloning}
              >
                {t('settings.repos.addRepo.tabs.folder')}
              </ButtonGroupItem>
              <ButtonGroupItem
                icon={GithubLogoIcon}
                active={mode === 'github'}
                onClick={() => setMode('github')}
                disabled={!!cloning}
              >
                {t('settings.repos.addRepo.tabs.github')}
              </ButtonGroupItem>
            </ButtonGroup>

            {mode === 'folder' ? (
              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium text-normal">
                  {t('settings.repos.addRepo.folder.pathLabel')}
                </label>
                <div className="flex gap-2">
                  <Input
                    value={manualPath}
                    onChange={(e) => {
                      setManualPath(e.target.value);
                      if (folderError) setFolderError(null);
                    }}
                    placeholder={t(
                      'settings.repos.addRepo.folder.pathPlaceholder'
                    )}
                    onCommandEnter={handleSubmitFolder}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleBrowse}
                    aria-label={t('settings.repos.addRepo.folder.browse')}
                  >
                    <FolderSimpleIcon className="h-4 w-4" weight="fill" />
                  </Button>
                </div>
                <p className="text-xs text-low">
                  {t('settings.repos.addRepo.folder.helper')}
                </p>
                {folderError && (
                  <p className="text-sm text-destructive">{folderError}</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <MagnifyingGlassIcon
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-low"
                    weight="bold"
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t(
                      'settings.repos.addRepo.github.searchPlaceholder'
                    )}
                    className="pl-9"
                    disabled={!!cloning}
                  />
                </div>

                <div className="border border-border rounded-sm h-[320px] overflow-auto bg-secondary/40">
                  {reposLoading ? (
                    <div className="flex items-center justify-center h-full gap-2 text-low">
                      <SpinnerIcon
                        className="h-4 w-4 animate-spin"
                        weight="bold"
                      />
                      <span className="text-sm">
                        {t('settings.repos.addRepo.github.loading')}
                      </span>
                    </div>
                  ) : reposErrorMessage ? (
                    <div className="p-4 flex flex-col items-start gap-2">
                      <p className="text-sm text-destructive">
                        {reposErrorMessage}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => refetchRepos()}
                      >
                        {t('common:buttons.retry')}
                      </Button>
                    </div>
                  ) : filteredRepos.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-sm text-low">
                      {search.trim()
                        ? t('settings.repos.addRepo.github.noMatches')
                        : t('settings.repos.addRepo.github.noRepos')}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border">
                      {filteredRepos.map((repo) => {
                        const isCloningThis = cloning === repo.nameWithOwner;
                        const isDisabled = !!cloning && !isCloningThis;
                        return (
                          <li key={repo.nameWithOwner}>
                            <button
                              type="button"
                              onClick={() => handleCloneRepo(repo)}
                              disabled={!!cloning}
                              className="w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-secondary/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <div className="pt-half flex-shrink-0">
                                {isCloningThis ? (
                                  <SpinnerIcon
                                    className="h-4 w-4 animate-spin text-brand"
                                    weight="bold"
                                  />
                                ) : (
                                  <GithubLogoIcon
                                    className="h-4 w-4 text-low"
                                    weight="bold"
                                  />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-normal truncate">
                                    {repo.nameWithOwner}
                                  </span>
                                  {repo.visibility &&
                                    repo.visibility.toLowerCase() !==
                                      'public' && (
                                      <span className="inline-flex items-center gap-1 text-xs text-low bg-secondary px-1.5 py-0.5 rounded-sm">
                                        <LockSimpleIcon
                                          className="h-3 w-3"
                                          weight="bold"
                                        />
                                        {repo.visibility.toLowerCase()}
                                      </span>
                                    )}
                                </div>
                                {repo.description && (
                                  <p className="text-xs text-low truncate">
                                    {repo.description}
                                  </p>
                                )}
                                {isCloningThis && (
                                  <p className="text-xs text-brand mt-half">
                                    {t('settings.repos.addRepo.github.cloning')}
                                  </p>
                                )}
                              </div>
                              {isDisabled && (
                                <span className="sr-only">
                                  {t(
                                    'settings.repos.addRepo.github.cloneInProgress'
                                  )}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {ghError && (
                  <p className="text-sm text-destructive">{ghError}</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={!!cloning}
            >
              {t('common:buttons.cancel')}
            </Button>
            {mode === 'folder' && (
              <Button
                onClick={handleSubmitFolder}
                disabled={!manualPath.trim()}
              >
                {t('settings.repos.addRepo.folder.submit')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const AddRepoDialog = defineModal<
  AddRepoDialogProps,
  AddRepoDialogResult
>(AddRepoDialogImpl);
