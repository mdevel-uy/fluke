import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Switch } from '@vibe/ui/components/Switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { ApiError, repoApi, workersApi, repoIssuesApi } from '@/shared/lib/api';
import { useRepoIssues, useSyncRepoIssues } from '@/features/issues';
import type {
  RepoIssue,
  IssuePriority,
  IssueLabel,
} from '@/features/issues/types';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import { workersKeys } from '@/features/workers';
import {
  useStartAllWorkers,
  useStartNextWorkerTask,
} from '@/features/workers/model/useWorkers';
import type { Worker, WorkerTask } from '@/features/sprint/types';
import { repoIssuesKeys } from '@/features/issues/model/repoIssuesKeys';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import { useAutoIngestReconciler } from '@/features/sprint/model/useAutoIngestReconciler';
import { SprintColumn } from './SprintColumn';
import { ColumnEmpty } from './ColumnEmpty';
import { WorkerChip } from './WorkerChip';
import { BacklogIssueCard } from './BacklogIssueCard';
import { QueuedTaskCard } from './QueuedTaskCard';
import { InProgressTaskCard } from './InProgressTaskCard';
import { InReviewTaskCard } from './InReviewTaskCard';
import { DoneTaskCard } from './DoneTaskCard';
import { FailedTaskCard } from './FailedTaskCard';
import { buildAssignToAgentPrompt } from './assignToAgentPrompt';
import { SprintFilterBar } from './SprintFilterBar';
import { IssueDetailPanel } from './IssueDetailPanel';
import type { SprintFilters } from './SprintFilterBar';

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'in_review']);
const DONE_LIMIT = 20;

type Toast = {
  id: number;
  variant: 'success' | 'error' | 'info';
  message: string;
};

const TOAST_DURATION_MS = 4000;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: Toast['variant'], message: string) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, variant, message }]);
      const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function findWorker(workers: Worker[], id: string): Worker | undefined {
  return workers.find((w) => w.id === id);
}

function groupByWorkerOrdered(
  tasks: WorkerTask[],
  workers: Worker[]
): Array<{ worker: Worker; tasks: WorkerTask[] }> {
  const byWorker = new Map<string, WorkerTask[]>();
  for (const task of tasks) {
    const list = byWorker.get(task.worker_id) ?? [];
    list.push(task);
    byWorker.set(task.worker_id, list);
  }
  const groups: Array<{ worker: Worker; tasks: WorkerTask[] }> = [];
  for (const worker of workers) {
    const list = byWorker.get(worker.id);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((a, b) => a.position - b.position);
    groups.push({ worker, tasks: sorted });
  }
  return groups;
}

function sortByPriority(issues: RepoIssue[]): RepoIssue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority != null ? (PRIORITY_ORDER[a.priority] ?? 4) : 4;
    const pb = b.priority != null ? (PRIORITY_ORDER[b.priority] ?? 4) : 4;
    return pa - pb;
  });
}

function filterIssues(
  issues: RepoIssue[],
  filters: SprintFilters,
  workersByIssue: Map<number, Worker>
): RepoIssue[] {
  const q = filters.q.trim().toLowerCase();
  return issues.filter((issue) => {
    if (q) {
      const matchesTitle = issue.title.toLowerCase().includes(q);
      const matchesNumber = String(issue.number).includes(q);
      if (!matchesTitle && !matchesNumber) return false;
    }
    if (filters.epic && issue.milestone !== filters.epic) return false;
    if (filters.label && !issue.labels.some((l) => l.name === filters.label))
      return false;
    if (filters.priority && issue.priority !== filters.priority) return false;
    if (filters.worker) {
      const worker = workersByIssue.get(issue.number);
      if (!worker || worker.id !== filters.worker) return false;
    }
    return true;
  });
}

function uniqueEpics(issues: RepoIssue[]): string[] {
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.milestone) seen.add(issue.milestone);
  }
  return Array.from(seen).sort();
}

function uniqueLabels(issues: RepoIssue[]): IssueLabel[] {
  const seen = new Map<string, IssueLabel>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      if (!seen.has(label.name)) seen.set(label.name, label);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function SprintPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('sprint.title'));
  const appNavigation = useAppNavigation();
  const queryClient = useQueryClient();
  const router = useRouter();

  // Update URL search params without TanStack Router typed navigate
  // (web-core doesn't have the route type declarations from local-web).
  const updateSearchParams = useCallback(
    (updates: Record<string, string | number | undefined>, replace = false) => {
      const url = new URL(window.location.href);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === undefined || value === '') {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, String(value));
        }
      });
      const target = url.pathname + (url.search || '');
      if (replace) {
        router.history.replace(target);
      } else {
        router.history.push(target);
      }
    },
    [router]
  );
  const search = useSearch({ strict: false }) as {
    repo?: string;
    q?: string;
    epic?: string;
    label?: string;
    priority?: IssuePriority;
    worker?: string;
    issue?: number;
  };

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
    appNavigation.goToSprint(targetId, { replace: true });
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
    isLoading: isLoadingIssues,
    isError: isIssuesError,
  } = useRepoIssues(selectedRepoId);

  const {
    data: workers = [],
    isLoading: isLoadingWorkers,
    isError: isWorkersError,
  } = useWorkers();

  const {
    tasks: allTasks,
    queuedCountByWorkerId,
    isLoading: isLoadingTasks,
    isError: isTasksError,
  } = useAllWorkerTasks(workers);

  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  const invalidateWorkerData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: workersKeys.all });
    if (selectedRepoId) {
      queryClient.invalidateQueries({
        queryKey: repoIssuesKeys.byRepo(selectedRepoId),
      });
    }
  }, [queryClient, selectedRepoId]);

  const createTaskMutation = useMutation({
    mutationFn: async (params: {
      workerId: string;
      title: string;
      prompt: string;
      issueNumber?: number | null;
      skills?: string[];
      forceDuplicate?: boolean;
    }) => {
      return workersApi.createTask(params.workerId, {
        repo_id: selectedRepoId!,
        title: params.title,
        prompt: params.prompt,
        issue_number: params.issueNumber ?? null,
        skills: params.skills ?? [],
        ...(params.forceDuplicate ? { force_duplicate: true } : {}),
      });
    },
    onSuccess: () => invalidateWorkerData(),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        pushToast('error', t('sprint.toast.assignDuplicate'));
      }
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.deleteTask(params.workerId, params.taskId);
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const swapTasksMutation = useMutation({
    mutationFn: async (params: { a: WorkerTask; b: WorkerTask }) => {
      await workersApi.updateTask(params.a.worker_id, params.a.id, {
        position: params.b.position,
      });
      await workersApi.updateTask(params.b.worker_id, params.b.id, {
        position: params.a.position,
      });
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const retryTaskMutation = useMutation({
    mutationFn: async (params: {
      task: WorkerTask;
      minQueuedPosition: number;
    }) => {
      await workersApi.updateTask(params.task.worker_id, params.task.id, {
        status: 'queued',
        position: params.minQueuedPosition - 1,
      });
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const discardTaskMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.deleteTask(params.workerId, params.taskId);
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const setPriorityMutation = useMutation({
    mutationFn: async (params: {
      issueNumber: number;
      priority: IssuePriority | null;
    }) => {
      if (!selectedRepoId) throw new Error('No repo selected');
      await repoIssuesApi.setPriority(
        selectedRepoId,
        params.issueNumber,
        params.priority
      );
    },
    onMutate: async ({ issueNumber, priority }) => {
      if (!selectedRepoId) return;
      const key = repoIssuesKeys.byRepo(selectedRepoId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<RepoIssue[]>(key);
      queryClient.setQueryData<RepoIssue[]>(key, (old) =>
        old
          ? old.map((i) => (i.number === issueNumber ? { ...i, priority } : i))
          : old
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && selectedRepoId) {
        queryClient.setQueryData(
          repoIssuesKeys.byRepo(selectedRepoId),
          ctx.prev
        );
      }
    },
    onSettled: () => {
      if (selectedRepoId) {
        queryClient.invalidateQueries({
          queryKey: repoIssuesKeys.byRepo(selectedRepoId),
        });
      }
    },
  });

  const startAllMutation = useStartAllWorkers();
  const startNextMutation = useStartNextWorkerTask();
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const setAutoIngest = useAutoIngestStore((s) => s.setAutoIngest);
  useAutoIngestReconciler(workers, queuedCountByWorkerId);

  // With auto-ingest on, an idle worker picks up its queue as soon as a task
  // is assigned. Conflicts (worker grabbed something else meanwhile) are fine.
  const maybeAutoStart = useCallback(
    (workerId: string) => {
      if (!autoIngest) return;
      const worker = findWorker(workers, workerId);
      if (!worker || worker.active_workspace_id) return;
      startNextMutation.mutate(workerId, {
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) return;
          pushToast('error', err instanceof Error ? err.message : String(err));
        },
      });
    },
    [autoIngest, workers, startNextMutation, pushToast]
  );

  const handleAssignIssue = useCallback(
    (issue: RepoIssue, workerId: string) => {
      if (!selectedRepoId) return;
      setBusyTaskId(`issue-${issue.id}`);
      const title = `#${issue.number} ${issue.title}`;
      const prompt = buildAssignToAgentPrompt(issue);
      // Extract skill names from labels with the convention `skill:<name>`.
      const skills = issue.labels
        .map((l) => l.name)
        .filter((n) => n.startsWith('skill:'))
        .map((n) => n.slice('skill:'.length))
        .filter(Boolean);
      createTaskMutation.mutate(
        { workerId, title, prompt, issueNumber: issue.number, skills },
        {
          onSettled: () => setBusyTaskId(null),
          onSuccess: () => maybeAutoStart(workerId),
          onError: (err) =>
            pushToast(
              'error',
              err instanceof Error ? err.message : String(err)
            ),
        }
      );
    },
    [createTaskMutation, selectedRepoId, pushToast, maybeAutoStart]
  );

  const handleRemoveTask = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      deleteTaskMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        {
          onSettled: () => setBusyTaskId(null),
          onError: (err) =>
            pushToast(
              'error',
              err instanceof Error ? err.message : String(err)
            ),
        }
      );
    },
    [deleteTaskMutation, pushToast]
  );

  const handleReorder = useCallback(
    (a: WorkerTask, b: WorkerTask) => {
      setBusyTaskId(a.id);
      swapTasksMutation.mutate(
        { a, b },
        {
          onSettled: () => setBusyTaskId(null),
          onError: (err) =>
            pushToast(
              'error',
              err instanceof Error ? err.message : String(err)
            ),
        }
      );
    },
    [swapTasksMutation, pushToast]
  );

  const handleRetryTask = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      const queued = allTasks.filter(
        (t) => t.worker_id === task.worker_id && t.status === 'queued'
      );
      const minPosition =
        queued.length > 0 ? Math.min(...queued.map((t) => t.position)) : 0;
      retryTaskMutation.mutate(
        { task, minQueuedPosition: minPosition },
        { onSettled: () => setBusyTaskId(null) }
      );
    },
    [retryTaskMutation, allTasks]
  );

  const handleDiscardTask = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      discardTaskMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        { onSettled: () => setBusyTaskId(null) }
      );
    },
    [discardTaskMutation]
  );

  const repoTasks = useMemo(
    () => allTasks.filter((task) => task.repo_id === selectedRepoId),
    [allTasks, selectedRepoId]
  );

  const activeTasksByIssueNumber = useMemo(() => {
    const set = new Set<number>();
    for (const task of repoTasks) {
      if (task.issue_number != null && ACTIVE_STATUSES.has(task.status)) {
        set.add(task.issue_number);
      }
    }
    return set;
  }, [repoTasks]);

  // Map issue number → worker currently handling it (for filter + detail panel)
  const workerByIssueNumber = useMemo(() => {
    const map = new Map<number, Worker>();
    for (const task of repoTasks) {
      if (task.issue_number != null && ACTIVE_STATUSES.has(task.status)) {
        const worker = findWorker(workers, task.worker_id);
        if (worker) map.set(task.issue_number, worker);
      }
    }
    return map;
  }, [repoTasks, workers]);

  const openIssues = useMemo(
    () => issues.filter((i) => i.state === 'open'),
    [issues]
  );

  const backlogIssuesRaw = useMemo(
    () =>
      openIssues.filter((issue) => !activeTasksByIssueNumber.has(issue.number)),
    [openIssues, activeTasksByIssueNumber]
  );

  // Derived filter state from URL
  const filters: SprintFilters = useMemo(
    () => ({
      q: search.q ?? '',
      epic: search.epic ?? '',
      label: search.label ?? '',
      priority: search.priority ?? '',
      worker: search.worker ?? '',
    }),
    [search.q, search.epic, search.label, search.priority, search.worker]
  );

  const handleFiltersChange = useCallback(
    (next: SprintFilters) => {
      updateSearchParams(
        {
          q: next.q || undefined,
          epic: next.epic || undefined,
          label: next.label || undefined,
          priority: next.priority || undefined,
          worker: next.worker || undefined,
        },
        true
      );
    },
    [updateSearchParams]
  );

  const filteredBacklogIssues = useMemo(
    () =>
      sortByPriority(
        filterIssues(backlogIssuesRaw, filters, workerByIssueNumber)
      ),
    [backlogIssuesRaw, filters, workerByIssueNumber]
  );

  // Available filter options derived from ALL backlog issues (not filtered)
  const allEpics = useMemo(
    () => uniqueEpics(backlogIssuesRaw),
    [backlogIssuesRaw]
  );
  const allLabels = useMemo(
    () => uniqueLabels(backlogIssuesRaw),
    [backlogIssuesRaw]
  );

  const queuedGroups = useMemo(
    () =>
      groupByWorkerOrdered(
        repoTasks.filter((task) => task.status === 'queued'),
        workers
      ),
    [repoTasks, workers]
  );

  const inProgressTasks = useMemo(
    () => repoTasks.filter((task) => task.status === 'in_progress'),
    [repoTasks]
  );

  const inReviewTasks = useMemo(
    () => repoTasks.filter((task) => task.status === 'in_review'),
    [repoTasks]
  );

  const doneTasks = useMemo(() => {
    const done = repoTasks.filter((task) => task.status === 'done');
    done.sort((a, b) => {
      const aTs = new Date(a.created_at).getTime();
      const bTs = new Date(b.created_at).getTime();
      return bTs - aTs;
    });
    return done.slice(0, DONE_LIMIT);
  }, [repoTasks]);

  const failedGroups = useMemo(
    () =>
      groupByWorkerOrdered(
        repoTasks.filter((task) => task.status === 'failed'),
        workers
      ),
    [repoTasks, workers]
  );

  // Enabling auto-ingest immediately kicks every idle worker with a queue.
  const handleAutoIngestChange = async (enabled: boolean) => {
    setAutoIngest(enabled);
    if (!enabled) return;
    try {
      const result = await startAllMutation.mutateAsync();
      const started = result.results.filter((r) => r.started).length;
      invalidateWorkerData();
      if (started > 0) {
        pushToast(
          'success',
          t('sprint.toast.startAllSuccess', { count: started })
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast('error', t('sprint.toast.startAllError', { message }));
    }
  };

  const syncMutation = useSyncRepoIssues(selectedRepoId);
  const isSyncing = syncMutation.isPending;

  const handleSync = () => {
    if (!selectedRepoId || isSyncing) return;
    syncMutation.mutate();
  };

  const handleRepoChange = (repoId: string) => {
    setStoredRepoId(repoId);
    appNavigation.goToSprint(repoId);
  };

  // Detail panel
  const openIssueNumber = search.issue;
  const detailIssue = useMemo(
    () =>
      openIssueNumber != null
        ? (issues.find((i) => i.number === openIssueNumber) ?? null)
        : null,
    [openIssueNumber, issues]
  );

  const openDetail = useCallback(
    (issue: RepoIssue) => {
      updateSearchParams({ issue: issue.number }, false);
    },
    [updateSearchParams]
  );

  const closeDetail = useCallback(() => {
    updateSearchParams({ issue: undefined }, false);
  }, [updateSearchParams]);

  const handlePriorityChange = useCallback(
    (issueNumber: number, priority: IssuePriority | null) => {
      setPriorityMutation.mutate({ issueNumber, priority });
    },
    [setPriorityMutation]
  );

  const showBoard =
    !!selectedRepoId &&
    !isLoadingIssues &&
    !isLoadingWorkers &&
    !isLoadingTasks &&
    !isIssuesError &&
    !isWorkersError &&
    !isTasksError;

  const hasFilters = !!(
    filters.q ||
    filters.epic ||
    filters.label ||
    filters.priority ||
    filters.worker
  );

  return (
    <div className="flex h-full w-full flex-col bg-md-background">
      <header className="flex items-center justify-between px-4 border-b border-md-outline-variant gap-4 h-12 shrink-0 bg-md-surface-container-lowest">
        <h1 className="text-title font-sans text-md-on-surface">
          {t('sprint.title')}
        </h1>
        <div className="flex items-center gap-3">
          <div className="min-w-[240px]">
            <Select
              value={selectedRepoId ?? ''}
              onValueChange={handleRepoChange}
              disabled={repos.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('sprint.repoSelectorPlaceholder')}
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
            onClick={handleSync}
            disabled={!selectedRepoId || isSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-md-outline-variant bg-md-surface-container text-body-sm font-semibold text-md-on-surface hover:bg-md-surface-container-high active:scale-95 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <MaterialIcon
              name={isSyncing ? 'progress_activity' : 'sync'}
              size="sm"
              className={isSyncing ? 'animate-spin' : ''}
            />
            {isSyncing ? t('sprint.syncing') : t('sprint.sync')}
          </button>
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            title={t('sprint.autoIngest.description')}
          >
            <Switch
              checked={autoIngest}
              onCheckedChange={handleAutoIngestChange}
              disabled={startAllMutation.isPending}
              aria-label={t('sprint.autoIngest.label')}
            />
            <span className="text-body-sm font-semibold text-md-on-surface">
              {t('sprint.autoIngest.label')}
            </span>
          </label>
        </div>
      </header>

      {showBoard && (
        <SprintFilterBar
          filters={filters}
          epics={allEpics}
          labels={allLabels}
          workers={workers}
          onFiltersChange={handleFiltersChange}
        />
      )}

      {toasts.length > 0 && (
        <div className="px-container-padding pt-4 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={[
                'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-body-sm',
                toast.variant === 'success'
                  ? 'border-success/30 bg-success/10 text-success'
                  : toast.variant === 'error'
                    ? 'border-md-error/30 bg-md-error/10 text-md-error'
                    : 'border-md-outline-variant bg-md-surface-container-low text-md-on-surface',
              ].join(' ')}
            >
              <span className="min-w-0 flex-1 leading-relaxed">
                {toast.message}
              </span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label={t('workers.toast.dismiss')}
                className="shrink-0 p-0.5 rounded-md text-md-on-surface-variant hover:bg-md-surface-container hover:text-md-on-surface cursor-pointer transition-colors active:scale-95"
              >
                <MaterialIcon name="close" size="sm" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoadingRepos ? (
          <div className="flex h-full items-center justify-center gap-2 text-md-on-surface-variant">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-primary"
            />
            <span className="text-body-md">{t('sprint.loadingRepos')}</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
            {t('sprint.noReposMessage')}
          </div>
        ) : !selectedRepoId ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-on-surface-variant">
            {t('sprint.selectRepoPrompt')}
          </div>
        ) : isLoadingIssues || isLoadingWorkers || isLoadingTasks ? (
          <div className="flex h-full items-center justify-center gap-2 text-md-on-surface-variant">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-primary"
            />
            <span className="text-body-md">{t('sprint.loading')}</span>
          </div>
        ) : isIssuesError || isWorkersError || isTasksError ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-error">
            {t('sprint.loadError')}
          </div>
        ) : (
          showBoard && (
            <div className="flex flex-row gap-4 h-full min-h-0 p-4 overflow-x-auto bg-md-background">
              <SprintColumn
                title={t('sprint.columns.backlog')}
                count={filteredBacklogIssues.length}
                className="min-w-[280px]"
              >
                {filteredBacklogIssues.length === 0 ? (
                  <ColumnEmpty
                    message={
                      hasFilters
                        ? t('sprint.filters.noResults')
                        : t('sprint.backlog.empty')
                    }
                  />
                ) : (
                  filteredBacklogIssues.map((issue) => (
                    <BacklogIssueCard
                      key={issue.id}
                      issue={issue}
                      workers={workers}
                      isAssigning={
                        busyTaskId === `issue-${issue.id}` &&
                        createTaskMutation.isPending
                      }
                      onAssign={(workerId) =>
                        handleAssignIssue(issue, workerId)
                      }
                      onPriorityChange={(priority) =>
                        handlePriorityChange(issue.number, priority)
                      }
                      onClick={() => openDetail(issue)}
                    />
                  ))
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.queued')}
                count={queuedGroups.reduce((sum, g) => sum + g.tasks.length, 0)}
                className="min-w-[280px]"
              >
                {queuedGroups.length === 0 ? (
                  <ColumnEmpty message={t('sprint.queued.empty')} />
                ) : (
                  queuedGroups.map(({ worker, tasks }) => (
                    <div key={worker.id} className="flex flex-col gap-2">
                      <WorkerChip worker={worker} />
                      {tasks.map((task, index) => (
                        <QueuedTaskCard
                          key={task.id}
                          task={task}
                          canMoveUp={index > 0}
                          canMoveDown={index < tasks.length - 1}
                          isBusy={busyTaskId === task.id}
                          onMoveUp={() => handleReorder(task, tasks[index - 1])}
                          onMoveDown={() =>
                            handleReorder(task, tasks[index + 1])
                          }
                          onRemove={() => handleRemoveTask(task)}
                        />
                      ))}
                    </div>
                  ))
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.inProgress')}
                count={inProgressTasks.length}
                className="min-w-[280px]"
              >
                {inProgressTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.inProgress.empty')} />
                ) : (
                  inProgressTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-2">
                        {worker && <WorkerChip worker={worker} />}
                        <InProgressTaskCard task={task} />
                      </div>
                    );
                  })
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.inReview')}
                count={inReviewTasks.length}
                className="min-w-[280px]"
              >
                {inReviewTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.inReview.empty')} />
                ) : (
                  inReviewTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-2">
                        {worker && <WorkerChip worker={worker} />}
                        <InReviewTaskCard task={task} />
                      </div>
                    );
                  })
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.failed')}
                count={failedGroups.reduce((sum, g) => sum + g.tasks.length, 0)}
                className="min-w-[280px]"
              >
                {failedGroups.length === 0 ? (
                  <ColumnEmpty message={t('sprint.failed.empty')} />
                ) : (
                  failedGroups.map(({ worker, tasks }) => (
                    <div key={worker.id} className="flex flex-col gap-2">
                      <WorkerChip worker={worker} />
                      {tasks.map((task) => (
                        <FailedTaskCard
                          key={task.id}
                          task={task}
                          isBusy={busyTaskId === task.id}
                          onRetry={() => handleRetryTask(task)}
                          onDiscard={() => handleDiscardTask(task)}
                        />
                      ))}
                    </div>
                  ))
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.done')}
                count={doneTasks.length}
                className="min-w-[280px]"
              >
                {doneTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.done.empty')} />
                ) : (
                  doneTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-2">
                        {worker && <WorkerChip worker={worker} />}
                        <DoneTaskCard task={task} />
                      </div>
                    );
                  })
                )}
              </SprintColumn>
            </div>
          )
        )}
      </div>

      {detailIssue && (
        <IssueDetailPanel
          issue={detailIssue}
          workers={workers}
          repoName={selectedRepo?.name ?? ''}
          onClose={closeDetail}
          onPriorityChange={(priority) =>
            handlePriorityChange(detailIssue.number, priority)
          }
        />
      )}
    </div>
  );
}
