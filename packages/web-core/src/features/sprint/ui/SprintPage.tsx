import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@phosphor-icons/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { repoApi, workersApi } from '@/shared/lib/api';
import { useRepoIssues } from '@/features/issues/model/useRepoIssues';
import type { RepoIssue } from '@/features/issues';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import { sprintKeys } from '@/features/sprint/model/sprintKeys';
import type { Worker, WorkerTask } from '@/features/sprint/types';
import { SprintColumn } from './SprintColumn';
import { ColumnEmpty } from './ColumnEmpty';
import { WorkerChip } from './WorkerChip';
import { BacklogIssueCard } from './BacklogIssueCard';
import { FreeTaskComposer } from './FreeTaskComposer';
import { QueuedTaskCard } from './QueuedTaskCard';
import { InProgressTaskCard } from './InProgressTaskCard';
import { InReviewTaskCard } from './InReviewTaskCard';
import { DoneTaskCard } from './DoneTaskCard';
import { buildAssignToAgentPrompt } from './assignToAgentPrompt';

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'in_review']);
const DONE_LIMIT = 20;

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

export function SprintPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('sprint.title'));
  const appNavigation = useAppNavigation();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { repo?: string };
  const selectedRepoIdFromUrl = search.repo;

  const { data: repos = [], isLoading: isLoadingRepos } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  useEffect(() => {
    if (selectedRepoIdFromUrl || repos.length === 0) return;
    appNavigation.goToSprint(repos[0].id, { replace: true });
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
    isLoading: isLoadingTasks,
    isError: isTasksError,
  } = useAllWorkerTasks(workers);

  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const invalidateWorkerData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: sprintKeys.workers });
    for (const worker of workers) {
      queryClient.invalidateQueries({
        queryKey: sprintKeys.tasksByWorker(worker.id),
      });
    }
  }, [queryClient, workers]);

  const createTaskMutation = useMutation({
    mutationFn: async (params: {
      workerId: string;
      title: string;
      prompt: string;
      issueNumber?: number | null;
    }) => {
      return workersApi.createTask(params.workerId, {
        repo_id: selectedRepoId!,
        title: params.title,
        prompt: params.prompt,
        issue_number: params.issueNumber ?? null,
      });
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (params: { workerId: string; taskId: string }) => {
      await workersApi.deleteTask(params.workerId, params.taskId);
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const swapTasksMutation = useMutation({
    mutationFn: async (params: { a: WorkerTask; b: WorkerTask }) => {
      // Swap two tasks' positions with two PATCH calls. Sequential because
      // both belong to the same worker's queue and race-based ordering is
      // rare here (single user, click-driven).
      await workersApi.updateTask(params.a.worker_id, params.a.id, {
        position: params.b.position,
      });
      await workersApi.updateTask(params.b.worker_id, params.b.id, {
        position: params.a.position,
      });
    },
    onSuccess: () => invalidateWorkerData(),
  });

  const handleAssignIssue = useCallback(
    (issue: RepoIssue, workerId: string) => {
      if (!selectedRepoId) return;
      setBusyTaskId(`issue-${issue.id}`);
      const title = `#${issue.number} ${issue.title}`;
      const prompt = buildAssignToAgentPrompt(issue);
      createTaskMutation.mutate(
        { workerId, title, prompt, issueNumber: issue.number },
        {
          onSettled: () => setBusyTaskId(null),
        }
      );
    },
    [createTaskMutation, selectedRepoId]
  );

  const handleFreeTaskCreate = useCallback(
    (params: { workerId: string; title: string; prompt: string }) => {
      if (!selectedRepoId) return;
      setBusyTaskId('free-composer');
      createTaskMutation.mutate(params, {
        onSettled: () => setBusyTaskId(null),
      });
    },
    [createTaskMutation, selectedRepoId]
  );

  const handleRemoveTask = useCallback(
    (task: WorkerTask) => {
      setBusyTaskId(task.id);
      deleteTaskMutation.mutate(
        { workerId: task.worker_id, taskId: task.id },
        {
          onSettled: () => setBusyTaskId(null),
        }
      );
    },
    [deleteTaskMutation]
  );

  const handleReorder = useCallback(
    (a: WorkerTask, b: WorkerTask) => {
      setBusyTaskId(a.id);
      swapTasksMutation.mutate(
        { a, b },
        {
          onSettled: () => setBusyTaskId(null),
        }
      );
    },
    [swapTasksMutation]
  );

  // Per repo, split tasks by status. Only tasks belonging to the selected
  // repo participate in the board (the backlog check further below uses
  // the same repo filter).
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

  const openIssues = useMemo(
    () => issues.filter((i) => i.state === 'open'),
    [issues]
  );

  const backlogIssues = useMemo(
    () =>
      openIssues.filter((issue) => !activeTasksByIssueNumber.has(issue.number)),
    [openIssues, activeTasksByIssueNumber]
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
    // Most-recent first by created_at.
    done.sort((a, b) => {
      const aTs = new Date(a.created_at).getTime();
      const bTs = new Date(b.created_at).getTime();
      return bTs - aTs;
    });
    return done.slice(0, DONE_LIMIT);
  }, [repoTasks]);

  const handleRepoChange = (repoId: string) => {
    appNavigation.goToSprint(repoId);
  };

  const isBoardBusy =
    createTaskMutation.isPending ||
    deleteTaskMutation.isPending ||
    swapTasksMutation.isPending;

  const showBoard =
    !!selectedRepoId &&
    !isLoadingIssues &&
    !isLoadingWorkers &&
    !isLoadingTasks &&
    !isIssuesError &&
    !isWorkersError &&
    !isTasksError;

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <header className="flex items-center justify-between px-double py-base border-b border-border gap-base">
        <div className="flex items-baseline gap-base min-w-0">
          <h1 className="text-lg font-semibold text-high">
            {t('sprint.title')}
          </h1>
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
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoadingRepos ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('sprint.loadingRepos')}</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-low">
            {t('sprint.noReposMessage')}
          </div>
        ) : !selectedRepoId ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-low">
            {t('sprint.selectRepoPrompt')}
          </div>
        ) : isLoadingIssues || isLoadingWorkers || isLoadingTasks ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('sprint.loading')}</span>
          </div>
        ) : isIssuesError || isWorkersError || isTasksError ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-error">
            {t('sprint.loadError')}
          </div>
        ) : (
          showBoard && (
            <div className="flex flex-row gap-base h-full min-h-0 p-base overflow-x-auto">
              <SprintColumn
                title={t('sprint.columns.backlog')}
                count={backlogIssues.length}
                className="min-w-[260px]"
              >
                <FreeTaskComposer
                  workers={workers}
                  isSubmitting={
                    busyTaskId === 'free-composer' &&
                    createTaskMutation.isPending
                  }
                  disabled={!selectedRepoId || isBoardBusy}
                  onCreate={handleFreeTaskCreate}
                />
                {backlogIssues.length === 0 ? (
                  <ColumnEmpty message={t('sprint.backlog.empty')} />
                ) : (
                  backlogIssues.map((issue) => (
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
                    />
                  ))
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.queued')}
                count={queuedGroups.reduce((sum, g) => sum + g.tasks.length, 0)}
                className="min-w-[260px]"
              >
                {queuedGroups.length === 0 ? (
                  <ColumnEmpty message={t('sprint.queued.empty')} />
                ) : (
                  queuedGroups.map(({ worker, tasks }) => (
                    <div key={worker.id} className="flex flex-col gap-half">
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
                className="min-w-[260px]"
              >
                {inProgressTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.inProgress.empty')} />
                ) : (
                  inProgressTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-half">
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
                className="min-w-[260px]"
              >
                {inReviewTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.inReview.empty')} />
                ) : (
                  inReviewTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-half">
                        {worker && <WorkerChip worker={worker} />}
                        <InReviewTaskCard task={task} />
                      </div>
                    );
                  })
                )}
              </SprintColumn>

              <SprintColumn
                title={t('sprint.columns.done')}
                count={doneTasks.length}
                className="min-w-[260px]"
              >
                {doneTasks.length === 0 ? (
                  <ColumnEmpty message={t('sprint.done.empty')} />
                ) : (
                  doneTasks.map((task) => {
                    const worker = findWorker(workers, task.worker_id);
                    return (
                      <div key={task.id} className="flex flex-col gap-half">
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
    </div>
  );
}
