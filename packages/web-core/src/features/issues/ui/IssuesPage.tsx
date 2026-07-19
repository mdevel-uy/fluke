import { useEffect, useMemo } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowClockwiseIcon, SpinnerIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { repoApi } from '@/shared/lib/api';
import {
  useRepoIssues,
  useSyncRepoIssues,
} from '@/features/issues/model/useRepoIssues';
import type { RepoIssue } from '@/features/issues/types';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { IssuesGroup } from './IssuesGroup';
import { IssuesEmptyState } from './IssuesEmptyState';

function partitionByState(issues: RepoIssue[]) {
  const open: RepoIssue[] = [];
  const closed: RepoIssue[] = [];
  for (const issue of issues) {
    if (issue.state === 'open') {
      open.push(issue);
    } else {
      closed.push(issue);
    }
  }
  return { open, closed };
}

export function IssuesPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('issues.title'));
  const appNavigation = useAppNavigation();
  const search = useSearch({ strict: false }) as { repo?: string };
  const selectedRepoIdFromUrl = search.repo;
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);

  const { data: repos = [], isLoading: isLoadingRepos } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  // Sync URL param → store so navigation to this view updates the remembered repo.
  useEffect(() => {
    if (
      selectedRepoIdFromUrl &&
      repos.some((r) => r.id === selectedRepoIdFromUrl)
    ) {
      setStoredRepoId(selectedRepoIdFromUrl);
    }
  }, [selectedRepoIdFromUrl, repos, setStoredRepoId]);

  // Auto-select: prefer stored repo, fall back to first repo.
  useEffect(() => {
    if (selectedRepoIdFromUrl || repos.length === 0) return;
    const targetId =
      storedRepoId && repos.some((r) => r.id === storedRepoId)
        ? storedRepoId
        : repos[0].id;
    appNavigation.goToIssues(targetId, { replace: true });
  }, [selectedRepoIdFromUrl, repos, storedRepoId, appNavigation]);

  const selectedRepoId = useMemo(() => {
    if (
      selectedRepoIdFromUrl &&
      repos.some((r) => r.id === selectedRepoIdFromUrl)
    ) {
      return selectedRepoIdFromUrl;
    }
    if (storedRepoId && repos.some((r) => r.id === storedRepoId)) {
      return storedRepoId;
    }
    return repos[0]?.id;
  }, [selectedRepoIdFromUrl, repos, storedRepoId]);

  const {
    data: issues = [],
    isLoading,
    isError,
  } = useRepoIssues(selectedRepoId);
  const syncMutation = useSyncRepoIssues(selectedRepoId);

  const { open, closed } = useMemo(() => partitionByState(issues), [issues]);
  const isSyncing = syncMutation.isPending;
  const hasIssues = issues.length > 0;

  const handleRefresh = () => {
    if (!selectedRepoId || isSyncing) return;
    syncMutation.mutate();
  };

  const handleRepoChange = (repoId: string) => {
    setStoredRepoId(repoId);
    appNavigation.goToIssues(repoId);
  };

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <header className="flex items-center justify-between px-double py-base border-b border-border gap-base">
        <div className="flex items-baseline gap-base min-w-0">
          <h1 className="text-lg font-semibold text-high">
            {t('issues.title')}
          </h1>
          {hasIssues && (
            <span className="text-sm text-low">
              {t('issues.countLabel', { count: issues.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-base">
          <div className="min-w-[240px]">
            <Select
              value={selectedRepoId ?? ''}
              onValueChange={handleRepoChange}
              disabled={repos.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('issues.repoSelectorPlaceholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.display_name || repo.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <PrimaryButton
            variant="tertiary"
            value={isSyncing ? t('issues.refreshing') : t('issues.refresh')}
            actionIcon={isSyncing ? 'spinner' : ArrowClockwiseIcon}
            onClick={handleRefresh}
            disabled={!selectedRepoId || isSyncing}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoadingRepos ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('issues.loadingRepos')}</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-low">
            {t('issues.noReposMessage')}
          </div>
        ) : !selectedRepoId ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-low">
            {t('issues.selectRepoPrompt')}
          </div>
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('issues.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-error">
            {t('issues.loadError')}
          </div>
        ) : !hasIssues ? (
          <div className="flex h-full">
            <IssuesEmptyState />
          </div>
        ) : (
          <div className="flex flex-col gap-double py-base">
            <IssuesGroup
              title={t('issues.openGroup')}
              count={open.length}
              issues={open}
              repoId={selectedRepoId}
            />
            <IssuesGroup
              title={t('issues.closedGroup')}
              count={closed.length}
              issues={closed}
              repoId={selectedRepoId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
