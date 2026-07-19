import { useEffect, useMemo } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCcw } from 'lucide-react';
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

  const { data: repos = [], isLoading: isLoadingRepos } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  // Auto-select the first repo when the URL has none and repos are loaded.
  useEffect(() => {
    if (selectedRepoIdFromUrl || repos.length === 0) return;
    appNavigation.goToIssues(repos[0].id, { replace: true });
  }, [selectedRepoIdFromUrl, repos, appNavigation]);

  const selectedRepoId = useMemo(() => {
    if (
      selectedRepoIdFromUrl &&
      repos.some((r) => r.id === selectedRepoIdFromUrl)
    ) {
      return selectedRepoIdFromUrl;
    }
    return repos[0]?.id;
  }, [selectedRepoIdFromUrl, repos]);

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
    appNavigation.goToIssues(repoId);
  };

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/60 gap-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-xl font-semibold text-high tracking-tight">
            {t('issues.title')}
          </h1>
          {hasIssues && (
            <span className="text-sm text-low">
              {t('issues.countLabel', { count: issues.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
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
            actionIcon={isSyncing ? 'spinner' : RefreshCcw}
            onClick={handleRefresh}
            disabled={!selectedRepoId || isSyncing}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoadingRepos ? (
          <div className="flex h-full items-center justify-center gap-2 text-low">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            <span className="text-sm">{t('issues.loadingRepos')}</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-low">
            {t('issues.noReposMessage')}
          </div>
        ) : !selectedRepoId ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-low">
            {t('issues.selectRepoPrompt')}
          </div>
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-low">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            <span className="text-sm">{t('issues.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-error">
            {t('issues.loadError')}
          </div>
        ) : !hasIssues ? (
          <div className="flex h-full">
            <IssuesEmptyState />
          </div>
        ) : (
          <div className="flex flex-col gap-6 py-6">
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
