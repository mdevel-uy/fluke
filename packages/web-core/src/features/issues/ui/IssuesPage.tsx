import { useEffect, useMemo } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { cn } from '@/shared/lib/utils';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { repoApi } from '@/shared/lib/api';
import {
  useRepoIssues,
  useSyncRepoIssues,
} from '@/features/issues/model/useRepoIssues';
import type { RepoIssue } from '@/features/issues/types';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import type { WorkerTask } from '@/features/sprint/types';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { IssuesGroup } from './IssuesGroup';
import { IssuesEmptyState } from './IssuesEmptyState';

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'in_review']);
const EMPTY_TASK_MAP = new Map<number, WorkerTask>();

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

  useEffect(() => {
    if (
      selectedRepoIdFromUrl &&
      repos.some((r) => r.id === selectedRepoIdFromUrl)
    ) {
      setStoredRepoId(selectedRepoIdFromUrl);
    }
  }, [selectedRepoIdFromUrl, repos, setStoredRepoId]);

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

  const { data: workers } = useWorkers();
  const { tasks: allTasks } = useAllWorkerTasks(workers);

  const activeTaskByIssueNumber = useMemo(() => {
    if (!selectedRepoId || allTasks.length === 0) return EMPTY_TASK_MAP;
    const map = new Map<number, WorkerTask>();
    for (const task of allTasks) {
      if (
        task.repo_id === selectedRepoId &&
        task.issue_number != null &&
        ACTIVE_STATUSES.has(task.status)
      ) {
        map.set(task.issue_number, task);
      }
    }
    return map;
  }, [allTasks, selectedRepoId]);

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
    <div className="flex h-full w-full flex-col bg-md-background">
      {/* MD3 top bar — 64px, surface-bright, border bottom */}
      <header className="flex items-center justify-between px-container-padding border-b border-md-outline-variant gap-4 h-16 shrink-0 bg-md-surface-bright">
        <h1 className="text-headline-md font-hanken font-semibold text-md-primary tracking-tight shrink-0">
          {t('issues.title')}
        </h1>

        {/* Segmented control: repo picker + refresh */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex bg-md-surface-container-low rounded-lg p-1 border border-md-outline-variant gap-1">
            <div className="min-w-[180px]">
              <Select
                value={selectedRepoId ?? ''}
                onValueChange={handleRepoChange}
                disabled={repos.length === 0}
              >
                <SelectTrigger className="border-0 bg-transparent shadow-none h-7 text-body-sm px-2 font-semibold text-md-on-surface">
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
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!selectedRepoId || isSyncing}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-body-sm text-md-on-surface-variant',
                'hover:bg-md-surface-container transition-colors duration-200',
                'active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed'
              )}
              title={isSyncing ? t('issues.refreshing') : t('issues.refresh')}
            >
              <MaterialIcon
                name="refresh"
                size="sm"
                className={isSyncing ? 'animate-spin' : ''}
              />
              <span className="hidden sm:inline">
                {isSyncing ? t('issues.refreshing') : t('issues.refresh')}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Open / Closed chip filters */}
      {hasIssues && (
        <div className="flex items-center gap-2 px-container-padding py-4 border-b border-md-outline-variant bg-md-surface-bright">
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-full text-body-sm font-semibold',
              'bg-md-surface-container-highest text-md-primary transition-all duration-200 active:scale-95'
            )}
          >
            {t('issues.openGroup')}
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-[18px] px-1.5 rounded-full bg-md-primary text-md-on-primary text-label-caps font-geist font-semibold tabular-nums">
              {open.length}
            </span>
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-full text-body-sm',
              'text-md-on-surface-variant hover:bg-md-surface-container-low transition-all duration-200 active:scale-95'
            )}
          >
            {t('issues.closedGroup')}
            <span className="text-md-outline text-label-caps font-geist font-semibold">
              {closed.length}
            </span>
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoadingRepos ? (
          <div className="flex h-full items-center justify-center gap-2 text-md-on-surface-variant">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-primary"
            />
            <span className="text-body-md">{t('issues.loadingRepos')}</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
            {t('issues.noReposMessage')}
          </div>
        ) : !selectedRepoId ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
            {t('issues.selectRepoPrompt')}
          </div>
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-md-on-surface-variant">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-primary"
            />
            <span className="text-body-md">{t('issues.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-error">
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
              taskByIssueNumber={activeTaskByIssueNumber}
            />
            <IssuesGroup
              title={t('issues.closedGroup')}
              count={closed.length}
              issues={closed}
              repoId={selectedRepoId}
              taskByIssueNumber={activeTaskByIssueNumber}
            />
          </div>
        )}
      </div>
    </div>
  );
}
