import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Switch } from '@vibe/ui/components/Switch';
import { Button } from '@vibe/ui/components/Button';
import { PageHeader, PageHeaderToggle } from '@vibe/ui/components/PageHeader';
import { cn } from '@/shared/lib/utils';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useRepos } from '@/shared/hooks/useRepos';
import {
  ApiError,
  workersApi,
  repoIssuesApi,
  type PlanUpgradeCta,
} from '@/shared/lib/api';
import { usePlanLimits } from '@/shared/hooks/usePlanLimits';
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
import { DesignReviewTaskCard } from './DesignReviewTaskCard';
import { DoneTaskCard } from './DoneTaskCard';
import { FailedTaskCard } from './FailedTaskCard';
import { buildAssignToAgentPrompt } from './assignToAgentPrompt';
import { SprintSidebar } from './SprintSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { extractSkillLabelNames } from '../lib/skillLabels';
import { IssueDetailPanel } from './IssueDetailPanel';
import { SprintFilterBar, type SprintFilters } from './SprintFilterBar';

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'in_review']);
const DONE_LIMIT = 20;

type Toast = {
  id: number;
  variant: 'success' | 'error' | 'info';
  message: string;
  cta?: PlanUpgradeCta;
};

const TOAST_DURATION_MS = 4000;
// Cap-hit toasts double as upsell prompts, so give the reader more time to
// notice and click the CTA before the toast fades.
const CTA_TOAST_DURATION_MS = 8000;

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
    (
      variant: Toast['variant'],
      message: string,
      options?: { cta?: PlanUpgradeCta }
    ) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [
        ...prev,
        { id, variant, message, cta: options?.cta },
      ]);
      const duration = options?.cta ? CTA_TOAST_DURATION_MS : TOAST_DURATION_MS;
      const timer = setTimeout(() => dismiss(id), duration);
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
  const [reRequestingTaskId, setReRequestingTaskId] = useState<string | null>(
    null
  );
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const { data: planLimits } = usePlanLimits();

  const pushPlanCapToast = useCallback(
    (workerName?: string | null) => {
      const limit = planLimits?.concurrent_agents_limit;
      const message =
        workerName != null
          ? limit != null
            ? t('workers.toast.planCapReachedWithLimit', {
                worker: workerName,
                limit,
              })
            : t('workers.toast.planCapReached', { worker: workerName })
          : limit != null
            ? t('sprint.toast.planCapReachedGenericWithLimit', { limit })
            : t('sprint.toast.planCapReachedGeneric');
      pushToast(
        'info',
        message,
        planLimits?.upgrade_cta ? { cta: planLimits.upgrade_cta } : undefined
      );
    },
    [planLimits, pushToast, t]
  );

  const invalidateWorkerData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: workersKeys.all });
    if (selectedRepoId) {
      queryClient.invalidateQueries({
        queryKey: repoIssuesKeys.byRepo(selectedRepoId),
      });
    }
  }, [queryClient, selectedRepoId]);

  // Refresh workers + tasks on page mount so navigating into the Kanban
  // never shows stale data. Issues refetch on mount via useRepoIssues.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: workersKeys.all });
  }, [queryClient]);

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
    onSuccess: () => {
      invalidateWorkerData();
      // The server auto-starts the retried task moments after the PATCH;
      // refresh again shortly so the card reflects in_progress without
      // waiting for the 30s poll.
      setTimeout(invalidateWorkerData, 2500);
    },
  });

  const discardTaskMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.deleteTask(params.workerId, params.taskId);
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const cancelTaskMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.cancelTask(params.workerId, params.taskId);
    },
    onSuccess: (_data, variables) => {
      // Drop the cancelled task from the worker's cached task list synchronously
      // so every consumer of `workersKeys.tasks(workerId)` — including a mounted
      // Analyst Desk on the same client — reflects the removal instantly,
      // instead of waiting for the invalidation refetch or the 30 s poll.
      queryClient.setQueryData<WorkerTask[]>(
        workersKeys.tasks(variables.workerId),
        (old) => old?.filter((t) => t.id !== variables.taskId) ?? old
      );
    },
    onSettled: () => invalidateWorkerData(),
  });

  const reRequestReviewMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.reRequestReview(params.workerId, params.taskId);
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const approveDesignMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.approveDesign(params.workerId, params.taskId);
    },
    onSuccess: () => {
      invalidateWorkerData();
      // Approval may auto-start the worker's next queued task moments later;
      // refresh again shortly so the board reflects it without the 30s poll.
      setTimeout(invalidateWorkerData, 2500);
    },
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

  // Toast when a review verdict first appears on an in_review task.
  const prevReviewResultsRef = useRef<Map<string, string | null | undefined>>(
    new Map()
  );
  const reviewToastInitializedRef = useRef(false);
  useEffect(() => {
    if (!reviewToastInitializedRef.current) {
      for (const task of allTasks) {
        prevReviewResultsRef.current.set(task.id, task.review_result);
      }
      reviewToastInitializedRef.current = true;
      return;
    }
    for (const task of allTasks) {
      const prev = prevReviewResultsRef.current.get(task.id);
      const curr = task.review_result;
      if (!prev && curr) {
        if (curr === 'approved') {
          pushToast(
            'success',
            t('sprint.toast.reviewApproved', { title: task.title })
          );
        } else if (curr === 'changes_requested') {
          pushToast(
            'info',
            t('sprint.toast.reviewChangesRequested', { title: task.title })
          );
        }
      }
      prevReviewResultsRef.current.set(task.id, curr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks]);

  // With auto-ingest on, an idle worker picks up its queue as soon as a task
  // is assigned. Conflicts (worker grabbed something else meanwhile) are
  // fine; a 429 means the concurrent-agents cap is full, which is the exact
  // moment to surface the upsell CTA.
  const maybeAutoStart = useCallback(
    (workerId: string) => {
      if (!autoIngest) return;
      const worker = findWorker(workers, workerId);
      if (!worker || worker.active_workspace_id) return;
      startNextMutation.mutate(workerId, {
        onError: (err) => {
          if (err instanceof ApiError && err.status === 429) {
            pushPlanCapToast(worker.name);
            return;
          }
          if (err instanceof ApiError && err.status === 409) return;
          pushToast('error', err instanceof Error ? err.message : String(err));
        },
      });
    },
    [autoIngest, workers, startNextMutation, pushToast, pushPlanCapToast]
  );

  const handleAssignIssue = useCallback(
    (issue: RepoIssue, workerId: string) => {
      if (!selectedRepoId) return;
      setBusyTaskId(`issue-${issue.id}`);
      const title = `#${issue.number} ${issue.title}`;
      const prompt = buildAssignToAgentPrompt(issue);
      // Extract skill names from labels with the convention `skill:<name>`.
      const skills = extractSkillLabelNames(issue.labels);
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

  const handleCancelTask = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      cancelTaskMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        {
          onSettled: () => setBusyTaskId(null),
          onError: (err) =>
            pushToast(
              'error',
              t('sprint.toast.cancelError', {
                message: err instanceof Error ? err.message : String(err),
              })
            ),
        }
      );
    },
    [cancelTaskMutation, pushToast, t]
  );

  const handleReRequestReview = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      setReRequestingTaskId(task.id);
      reRequestReviewMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        {
          onSettled: () => {
            setBusyTaskId(null);
            setReRequestingTaskId(null);
          },
          onSuccess: () =>
            pushToast('success', t('sprint.toast.reRequestReviewSuccess')),
          onError: (err) => {
            // Backend returns a machine-readable error code as the message
            // (e.g. `max_review_rounds_reached`) so the UI can localize
            // without shipping the English fallback to end users.
            const code =
              err instanceof ApiError && err.message ? err.message : '';
            const key =
              code === 'max_review_rounds_reached'
                ? 'sprint.toast.reRequestReviewMaxRounds'
                : code === 'no_open_pr'
                  ? 'sprint.toast.reRequestReviewNoOpenPr'
                  : code === 'no_reviewer_assigned'
                    ? 'sprint.toast.reRequestReviewNoReviewer'
                    : code === 'review_already_in_progress'
                      ? 'sprint.toast.reRequestReviewInProgress'
                      : code === 'no_changes_requested'
                        ? 'sprint.toast.reRequestReviewNoChangesRequested'
                        : code === 'pr_head_unchanged'
                          ? 'sprint.toast.reRequestReviewHeadUnchanged'
                          : 'sprint.toast.reRequestReviewError';
            pushToast(
              'error',
              t(key, {
                message: err instanceof Error ? err.message : String(err),
              })
            );
          },
        }
      );
    },
    [reRequestReviewMutation, pushToast, t]
  );

  const handleApproveDesign = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      approveDesignMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        {
          onSettled: () => setBusyTaskId(null),
          onSuccess: () =>
            pushToast(
              'success',
              t('sprint.toast.designApproved', { title: task.title })
            ),
          onError: (err) =>
            pushToast(
              'error',
              t('sprint.toast.designApproveError', {
                message: err instanceof Error ? err.message : String(err),
              })
            ),
        }
      );
    },
    [approveDesignMutation, pushToast, t]
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
      const capHit = result.results.some(
        (r) => !r.started && r.reason === 'in_review_cap_reached'
      );
      invalidateWorkerData();
      if (started > 0) {
        pushToast(
          'success',
          t('sprint.toast.startAllSuccess', { count: started })
        );
      }
      // Auto-ingest tried every worker; if any of them stayed queued because
      // the cap was full, surface the upsell CTA once (not once per worker).
      if (capHit) {
        pushPlanCapToast(null);
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
    <div className="flex h-full w-full flex-col bg-primary">
      <PageHeader
        title={t('sprint.title')}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 gap-1.5 text-sm"
              onClick={handleSync}
              disabled={!selectedRepoId || isSyncing}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')}
                strokeWidth={1.75}
              />
              {isSyncing ? t('sprint.syncing') : t('sprint.sync')}
            </Button>
            <PageHeaderToggle
              label={t('sprint.autoIngest.label')}
              title={t('sprint.autoIngest.description')}
            >
              <Switch
                checked={autoIngest}
                onCheckedChange={handleAutoIngestChange}
                disabled={startAllMutation.isPending}
                aria-label={t('sprint.autoIngest.label')}
              />
            </PageHeaderToggle>
          </>
        }
      />

      {/* Filters live in the shell sidebar (SHELL-SPEC R9) AND as a top
          filter bar, matching Issues (decisión Dani 29-jul) — same state,
          two surfaces. */}
      <ShellSidebarPortal>
        <SprintSidebar
          filters={filters}
          epics={allEpics}
          labels={allLabels}
          workers={workers}
          onFiltersChange={handleFiltersChange}
        />
      </ShellSidebarPortal>
      <SprintFilterBar
        filters={filters}
        epics={allEpics}
        labels={allLabels}
        workers={workers}
        onFiltersChange={handleFiltersChange}
        hideSearch
      />

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
              <div className="min-w-0 flex-1 leading-relaxed">
                <span>{toast.message}</span>
                {toast.cta ? (
                  <>
                    {' '}
                    <a
                      href={toast.cta.url}
                      target={
                        toast.cta.url.startsWith('mailto:')
                          ? undefined
                          : '_blank'
                      }
                      rel="noopener noreferrer"
                      className="font-semibold underline underline-offset-2 hover:no-underline"
                    >
                      {toast.cta.label}
                    </a>
                  </>
                ) : null}
              </div>
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
            <div className="flex flex-row gap-4 h-full min-h-0 p-4 overflow-x-auto bg-primary">
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
                        <InProgressTaskCard
                          task={task}
                          isBusy={busyTaskId === task.id}
                          onStop={() => handleCancelTask(task)}
                        />
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
                        {worker?.role === 'designer' ? (
                          <DesignReviewTaskCard
                            task={task}
                            isBusy={busyTaskId === task.id}
                            onApprove={() => handleApproveDesign(task)}
                            onUnassign={() => handleCancelTask(task)}
                          />
                        ) : (
                          <InReviewTaskCard
                            task={task}
                            isBusy={busyTaskId === task.id}
                            onUnassign={() => handleCancelTask(task)}
                            onReRequestReview={() =>
                              handleReRequestReview(task)
                            }
                            isReRequestingReview={
                              reRequestingTaskId === task.id
                            }
                          />
                        )}
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
                        <DoneTaskCard
                          task={task}
                          worker={worker ?? undefined}
                          isBusy={busyTaskId === task.id}
                          onRemove={() => handleRemoveTask(task)}
                        />
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
