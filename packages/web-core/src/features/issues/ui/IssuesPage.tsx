import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { cn } from '@/shared/lib/utils';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useRepos } from '@/shared/hooks/useRepos';
import {
  useRepoIssues,
  useSyncRepoIssues,
  useAddIssueLabel,
  useRemoveIssueLabel,
  useCloseIssue,
} from '@/features/issues/model/useRepoIssues';
import type { RepoIssue, IssueLabel } from '@/features/issues/types';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import { workersKeys } from '@/features/workers/model/workersKeys';
import type { WorkerTask } from '@/features/sprint/types';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { IssuesGroup } from './IssuesGroup';
import { IssuesEmptyState } from './IssuesEmptyState';
import { IssuesToolbar } from './IssuesToolbar';
import { IssuesSidebar } from './IssuesSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import type {
  IssueFilters,
  IssuePriorityFilter,
  IssueStateFilter,
  IssueGroupBy,
  IssueWorkerOption,
} from './IssuesToolbar';
import { IssueDetailDrawer } from './IssueDetailDrawer';

// ---------------------------------------------------------------------------
// URL params → filter state helpers
// ---------------------------------------------------------------------------

type RawSearch = {
  repo?: string;
  q?: string;
  state?: IssueStateFilter;
  priority?: string;
  labels?: string;
  milestones?: string;
  workers?: string;
  groupBy?: 'none' | 'label' | 'milestone';
  issue?: number;
};

function filtersFromUrl(s: RawSearch): IssueFilters {
  return {
    search: s.q ?? '',
    state: s.state ?? 'open',
    priorities: s.priority
      ? (s.priority.split(',').filter(Boolean) as IssuePriorityFilter[])
      : [],
    labels: s.labels ? s.labels.split(',').filter(Boolean) : [],
    milestones: s.milestones ? s.milestones.split(',').filter(Boolean) : [],
    workers: s.workers ? s.workers.split(',').filter(Boolean) : [],
    groupBy: (s.groupBy as IssueGroupBy) ?? 'none',
  };
}

function filtersToUrlParams(f: IssueFilters): Partial<RawSearch> {
  return {
    q: f.search || undefined,
    state: f.state !== 'open' ? f.state : undefined,
    priority: f.priorities.length ? f.priorities.join(',') : undefined,
    labels: f.labels.length ? f.labels.join(',') : undefined,
    milestones: f.milestones.length ? f.milestones.join(',') : undefined,
    workers: f.workers.length ? f.workers.join(',') : undefined,
    groupBy: f.groupBy !== 'none' ? f.groupBy : undefined,
  };
}

// ---------------------------------------------------------------------------
// Worker-task overlay
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'in_review']);
const EMPTY_TASK_MAP = new Map<number, WorkerTask>();

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const TASK_STATUS_FILTERS = new Set(['queued', 'in_progress', 'in_review']);

function applyFilters(
  issues: RepoIssue[],
  filters: IssueFilters,
  taskByIssueNumber: Map<number, WorkerTask>
): RepoIssue[] {
  return issues.filter((issue) => {
    if (filters.state === 'open' && issue.state !== 'open') return false;
    if (filters.state === 'closed' && issue.state !== 'closed') return false;
    if (TASK_STATUS_FILTERS.has(filters.state)) {
      const task = taskByIssueNumber.get(issue.number);
      if (!task || task.status !== filters.state) return false;
    }

    if (filters.workers.length > 0) {
      const task = taskByIssueNumber.get(issue.number);
      if (!task || !filters.workers.includes(task.worker_id)) return false;
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matchesTitle = issue.title.toLowerCase().includes(q);
      const matchesNumber =
        `#${issue.number}`.includes(q) || String(issue.number).includes(q);
      if (!matchesTitle && !matchesNumber) return false;
    }

    if (filters.priorities.length > 0) {
      if (
        !issue.priority ||
        !filters.priorities.includes(issue.priority as IssuePriorityFilter)
      ) {
        return false;
      }
    }

    if (filters.labels.length > 0) {
      const issueLabels = new Set(issue.labels.map((l) => l.name));
      if (!filters.labels.some((l) => issueLabels.has(l))) return false;
    }

    if (filters.milestones.length > 0) {
      if (!issue.milestone || !filters.milestones.includes(issue.milestone)) {
        return false;
      }
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface IssueGroup {
  key: string;
  title: string;
  issues: RepoIssue[];
}

function groupIssues(
  issues: RepoIssue[],
  groupBy: IssueGroupBy,
  openLabel: string,
  closedLabel: string,
  noGroupLabel: string,
  noMilestoneLabel: string
): IssueGroup[] {
  if (groupBy === 'none') {
    const open = issues.filter((i) => i.state === 'open');
    const closed = issues.filter((i) => i.state !== 'open');
    return [
      { key: 'open', title: openLabel, issues: open },
      { key: 'closed', title: closedLabel, issues: closed },
    ];
  }

  const map = new Map<string, RepoIssue[]>();
  for (const issue of issues) {
    const keys: string[] = [];
    if (groupBy === 'label') {
      if (issue.labels.length === 0) {
        keys.push('');
      } else {
        for (const l of issue.labels) keys.push(l.name);
      }
    } else {
      keys.push(issue.milestone ?? '');
    }
    for (const k of keys) {
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(issue);
    }
  }

  const groups: IssueGroup[] = [];
  for (const [key, group] of map.entries()) {
    groups.push({
      key: key || '__none__',
      title: key || (groupBy === 'label' ? noGroupLabel : noMilestoneLabel),
      issues: group,
    });
  }

  groups.sort((a, b) => {
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return a.title.localeCompare(b.title);
  });

  return groups;
}

// ---------------------------------------------------------------------------
// Derive unique values for filter dropdowns
// ---------------------------------------------------------------------------

function deriveAvailableLabels(issues: RepoIssue[]): IssueLabel[] {
  const map = new Map<string, IssueLabel>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      if (!map.has(label.name)) map.set(label.name, label);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function deriveAvailableMilestones(issues: RepoIssue[]): string[] {
  const set = new Set<string>();
  for (const issue of issues) {
    if (issue.milestone) set.add(issue.milestone);
  }
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IssuesPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('issues.title'));
  const appNavigation = useAppNavigation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as RawSearch;
  const selectedRepoIdFromUrl = search.repo;
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);

  // Refresh workers + tasks on page mount so navigating into Issues never
  // shows stale data. Issues themselves refetch on mount via useRepoIssues.
  // Ongoing auto-refresh of the workers overlay (every 30s and on window
  // focus, per issue #155) is provided by the shared useWorkers /
  // useAllWorkerTasks hooks below — do not swap them for a non-polling
  // variant without preserving that behavior.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: workersKeys.all });
  }, [queryClient]);

  const filters = useMemo(() => filtersFromUrl(search), [search]);
  const selectedIssueNumber = search.issue;

  const { repos, isLoadingRepos } = useRepos();

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

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selectedRepoId),
    [repos, selectedRepoId]
  );

  const {
    data: issues = [],
    isLoading,
    isError,
  } = useRepoIssues(selectedRepoId);
  const syncMutation = useSyncRepoIssues(selectedRepoId);
  const addLabelMutation = useAddIssueLabel(selectedRepoId);
  const removeLabelMutation = useRemoveIssueLabel(selectedRepoId);
  const closeIssueMutation = useCloseIssue(selectedRepoId);

  const { data: workers } = useWorkers();
  const { tasks: allTasks } = useAllWorkerTasks(workers);
  const { workspaces, archivedWorkspaces } = useWorkspaces();

  const workerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const worker of workers ?? []) map.set(worker.id, worker.name);
    return map;
  }, [workers]);

  const branchByWorkspaceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of [...workspaces, ...archivedWorkspaces]) {
      map.set(ws.id, ws.branch);
    }
    return map;
  }, [workspaces, archivedWorkspaces]);

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

  const isSyncing = syncMutation.isPending;
  const hasIssues = issues.length > 0;

  const availableLabels = useMemo(
    () => deriveAvailableLabels(issues),
    [issues]
  );
  const availableMilestones = useMemo(
    () => deriveAvailableMilestones(issues),
    [issues]
  );

  const availableWorkers = useMemo<IssueWorkerOption[]>(
    () =>
      (workers ?? [])
        .map((w) => ({ id: w.id, name: w.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [workers]
  );

  const filteredIssues = useMemo(
    () => applyFilters(issues, filters, activeTaskByIssueNumber),
    [issues, filters, activeTaskByIssueNumber]
  );

  const groups = useMemo(
    () =>
      groupIssues(
        filteredIssues,
        filters.groupBy,
        t('issues.openGroup'),
        t('issues.closedGroup'),
        t('issues.filters.noLabel'),
        t('issues.filters.noMilestone')
      ),
    [filteredIssues, filters.groupBy, t]
  );

  const selectedIssue = useMemo(
    () =>
      selectedIssueNumber != null
        ? (issues.find((i) => i.number === selectedIssueNumber) ?? null)
        : null,
    [issues, selectedIssueNumber]
  );

  const selectedIssueLinkedTask = useMemo(
    () =>
      selectedIssue
        ? activeTaskByIssueNumber.get(selectedIssue.number)
        : undefined,
    [selectedIssue, activeTaskByIssueNumber]
  );

  const updateUrl = useCallback(
    (params: Partial<RawSearch>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (navigate as any)({
        search: (prev: RawSearch) => {
          const next = { ...prev, ...params };
          (Object.keys(next) as (keyof RawSearch)[]).forEach((k) => {
            if (next[k] === undefined) delete next[k];
          });
          return next;
        },
        replace: true,
      });
    },
    [navigate]
  );

  const handleFilterChange = useCallback(
    (newFilters: IssueFilters) => {
      updateUrl(filtersToUrlParams(newFilters));
    },
    [updateUrl]
  );

  const handleRefresh = () => {
    if (!selectedRepoId || isSyncing) return;
    syncMutation.mutate();
  };

  const handleSelectIssue = useCallback(
    (issue: RepoIssue) => {
      updateUrl({ issue: issue.number });
    },
    [updateUrl]
  );

  const handleCloseDrawer = useCallback(() => {
    updateUrl({ issue: undefined });
  }, [updateUrl]);

  const handleAddLabel = useCallback(
    async (issueNumber: number, label: string, color?: string) => {
      await addLabelMutation.mutateAsync({ issueNumber, label, color });
    },
    [addLabelMutation]
  );

  const handleRemoveLabel = useCallback(
    async (issueNumber: number, labelName: string) => {
      await removeLabelMutation.mutateAsync({ issueNumber, labelName });
    },
    [removeLabelMutation]
  );

  const handleCloseIssue = useCallback(
    async (issueNumber: number) => {
      await closeIssueMutation.mutateAsync(issueNumber);
      if (selectedIssueNumber === issueNumber) {
        handleCloseDrawer();
      }
    },
    [closeIssueMutation, selectedIssueNumber, handleCloseDrawer]
  );

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      {/* MD3 top bar — 64px, surface-bright, border bottom */}
      <PageHeader
        title={t('issues.title')}
        actions={
          <Button
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 text-sm"
            onClick={handleRefresh}
            disabled={!selectedRepoId || isSyncing}
            title={isSyncing ? t('issues.refreshing') : t('issues.refresh')}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')}
              strokeWidth={1.75}
            />
            {isSyncing ? t('issues.refreshing') : t('issues.refresh')}
          </Button>
        }
      />

      {/* Search, repo, views and labels live in the shell sidebar (SHELL-SPEC R9);
          the toolbar keeps the advanced filters the sidebar doesn't cover. */}
      <ShellSidebarPortal>
        <IssuesSidebar
          filters={filters}
          availableLabels={availableLabels}
          onChange={handleFilterChange}
        />
      </ShellSidebarPortal>
      {hasIssues && (
        <IssuesToolbar
          filters={filters}
          availableLabels={availableLabels}
          availableMilestones={availableMilestones}
          availableWorkers={availableWorkers}
          onChange={handleFilterChange}
          hideSearch
          hiddenFilterIds={['state', 'label']}
        />
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
        ) : filteredIssues.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
            {t('issues.filters.noResults')}
          </div>
        ) : (
          <div className="flex flex-col gap-6 py-6">
            {groups.map((group) =>
              group.issues.length > 0 ? (
                <IssuesGroup
                  key={group.key}
                  title={group.title}
                  count={group.issues.length}
                  issues={group.issues}
                  repoId={selectedRepoId}
                  taskByIssueNumber={activeTaskByIssueNumber}
                  workerNameById={workerNameById}
                  branchByWorkspaceId={branchByWorkspaceId}
                  selectedIssueId={selectedIssue?.id}
                  onSelectIssue={handleSelectIssue}
                  onArchive={handleCloseIssue}
                />
              ) : null
            )}
          </div>
        )}
      </div>

      {/* Issue detail drawer */}
      <IssueDetailDrawer
        issue={selectedIssue}
        repoName={selectedRepo?.name ?? ''}
        repoId={selectedRepoId ?? ''}
        availableLabels={availableLabels}
        linkedTask={selectedIssueLinkedTask}
        onClose={handleCloseDrawer}
        onAddLabel={handleAddLabel}
        onRemoveLabel={handleRemoveLabel}
        onArchiveIssue={handleCloseIssue}
      />
    </div>
  );
}
