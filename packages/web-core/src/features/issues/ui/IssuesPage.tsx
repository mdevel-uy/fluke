import { useCallback, useEffect, useMemo } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
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
  useAddIssueLabel,
  useRemoveIssueLabel,
  useCloseIssue,
} from '@/features/issues/model/useRepoIssues';
import type { RepoIssue } from '@/features/issues/types';
import type { IssueLabel } from 'shared/types';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { IssuesGroup } from './IssuesGroup';
import { IssuesEmptyState } from './IssuesEmptyState';
import { IssuesToolbar, DEFAULT_FILTERS } from './IssuesToolbar';
import type {
  IssueFilters,
  IssuePriorityFilter,
  IssueGroupBy,
} from './IssuesToolbar';
import { IssueDetailDrawer } from './IssueDetailDrawer';

// ---------------------------------------------------------------------------
// URL params → filter state helpers
// ---------------------------------------------------------------------------

type RawSearch = {
  repo?: string;
  q?: string;
  state?: 'all' | 'open' | 'closed';
  priority?: string;
  labels?: string;
  milestones?: string;
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
    groupBy: f.groupBy !== 'none' ? f.groupBy : undefined,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function applyFilters(issues: RepoIssue[], filters: IssueFilters): RepoIssue[] {
  return issues.filter((issue) => {
    // state
    if (filters.state === 'open' && issue.state !== 'open') return false;
    if (filters.state === 'closed' && issue.state !== 'closed') return false;

    // text search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matchesTitle = issue.title.toLowerCase().includes(q);
      const matchesNumber =
        `#${issue.number}`.includes(q) || String(issue.number).includes(q);
      if (!matchesTitle && !matchesNumber) return false;
    }

    // priority
    if (filters.priorities.length > 0) {
      if (
        !issue.priority ||
        !filters.priorities.includes(issue.priority as IssuePriorityFilter)
      ) {
        return false;
      }
    }

    // labels
    if (filters.labels.length > 0) {
      const issueLabels = new Set(issue.labels.map((l) => l.name));
      if (!filters.labels.some((l) => issueLabels.has(l))) return false;
    }

    // milestones
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

  // Sort: named groups first, then "no ..." last
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
  const search = useSearch({ strict: false }) as RawSearch;
  const selectedRepoIdFromUrl = search.repo;
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);

  const filters = useMemo(() => filtersFromUrl(search), [search]);
  const selectedIssueNumber = search.issue;

  const { data: repos = [], isLoading: isLoadingRepos } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  // Sync URL param → store
  useEffect(() => {
    if (
      selectedRepoIdFromUrl &&
      repos.some((r) => r.id === selectedRepoIdFromUrl)
    ) {
      setStoredRepoId(selectedRepoIdFromUrl);
    }
  }, [selectedRepoIdFromUrl, repos, setStoredRepoId]);

  // Auto-select
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

  const isSyncing = syncMutation.isPending;
  const hasIssues = issues.length > 0;

  // Available filter options derived from all (unfiltered) issues
  const availableLabels = useMemo(
    () => deriveAvailableLabels(issues),
    [issues]
  );
  const availableMilestones = useMemo(
    () => deriveAvailableMilestones(issues),
    [issues]
  );

  // Apply filters
  const filteredIssues = useMemo(
    () => applyFilters(issues, filters),
    [issues, filters]
  );

  // Group filtered issues
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

  // Selected issue for drawer
  const selectedIssue = useMemo(
    () =>
      selectedIssueNumber != null
        ? (issues.find((i) => i.number === selectedIssueNumber) ?? null)
        : null,
    [issues, selectedIssueNumber]
  );

  const updateUrl = useCallback(
    (params: Partial<RawSearch>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (navigate as any)({
        search: (prev: RawSearch) => {
          const next = { ...prev, ...params };
          // Remove keys set to undefined
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

  const handleRepoChange = (repoId: string) => {
    setStoredRepoId(repoId);
    appNavigation.goToIssues(repoId);
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
      // If the archived issue was open in the drawer, close it
      if (selectedIssueNumber === issueNumber) {
        handleCloseDrawer();
      }
    },
    [closeIssueMutation, selectedIssueNumber, handleCloseDrawer]
  );

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

      {/* Toolbar (only when there are issues) */}
      {hasIssues && (
        <IssuesToolbar
          filters={filters}
          availableLabels={availableLabels}
          availableMilestones={availableMilestones}
          onChange={handleFilterChange}
        />
      )}

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
        ) : filteredIssues.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-low">
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
                  selectedIssueId={selectedIssue?.id}
                  onSelectIssue={handleSelectIssue}
                  onRemoveLabel={handleRemoveLabel}
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
        onClose={handleCloseDrawer}
        onAddLabel={handleAddLabel}
        onRemoveLabel={handleRemoveLabel}
        onArchiveIssue={handleCloseIssue}
      />
    </div>
  );
}
