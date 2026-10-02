import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Clock3,
  Loader2,
  Plus,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { WorkerResponse } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { ApiError, type PlanUpgradeCta } from '@/shared/lib/api';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { usePlanLimits } from '@/shared/hooks/usePlanLimits';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { reviewGate } from '@vibe/ui/lib/reviewGate';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';
import { cn } from '@/shared/lib/utils';
import {
  useArchivedWorkers,
  useArchiveWorker,
  useDeleteAllArchivedWorkers,
  useDeleteWorker,
  useDuplicateWorker,
  useStartNextWorkerTask,
  useUnarchiveWorker,
  useWorkers,
} from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import { useAutoIngestReconciler } from '@/features/sprint/model/useAutoIngestReconciler';
import type { WorkerTask } from '@/features/sprint/types';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { ArchivedWorkersSection } from './ArchivedWorkersSection';
import { WorkerCard } from './WorkerCard';
import { WorkersSidebar, workerCardDomId } from './WorkersSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
import { WorkersEmptyState } from './WorkersEmptyState';
import { WorkerFormDialog } from './WorkerFormDialog';
import {
  WorkersFilterBar,
  emptyFilterState,
  isFilterActive,
  type WorkersFilterState,
} from './WorkersFilterBar';
import { WorkersFilterEmptyState } from './WorkersFilterEmptyState';
import { bucketForModel, deriveWorkerStatus } from '../model/workerStatus';

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-md-surface-container-lowest p-3">
      <div className="flex items-center gap-1.5 font-sans text-label uppercase text-low">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        <span>{label}</span>
      </div>
      <p className="font-sans text-heading leading-none text-high tabular-nums">
        {value}
      </p>
    </div>
  );
}

type Toast = {
  id: number;
  variant: 'success' | 'error' | 'info';
  message: string;
  cta?: PlanUpgradeCta;
};

const TOAST_DURATION_MS = 4000;
// Cap-hit toasts pull double duty as upsell prompts, so give the reader
// enough time to actually notice and click the CTA before the toast fades.
const CTA_TOAST_DURATION_MS = 8000;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
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

export function WorkersPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('workers.title'));

  const { data: planLimits } = usePlanLimits();
  const { data: workers = [], isLoading, isError } = useWorkers();
  // One discovery stream for the whole page: maps a worker's model alias
  // ("opus") to the model it actually resolves to ("Opus 5.5") for the chip.
  const { config: systemConfig } = useUserSystem();
  const { config: modelConfig } = useModelSelectorConfig(
    systemConfig?.executor_profile?.executor ?? null
  );
  const modelNameById = useMemo(
    () => new Map((modelConfig?.models ?? []).map((m) => [m.id, m.name])),
    [modelConfig]
  );
  const {
    data: archivedWorkers = [],
    isLoading: isArchivedLoading,
    isError: isArchivedError,
  } = useArchivedWorkers();
  const startMutation = useStartNextWorkerTask();
  const deleteMutation = useDeleteWorker();
  const deleteAllArchivedMutation = useDeleteAllArchivedWorkers();
  const duplicateMutation = useDuplicateWorker();
  const archiveMutation = useArchiveWorker();
  const unarchiveMutation = useUnarchiveWorker();
  const { tasks: allTasks, queuedCountByWorkerId } = useAllWorkerTasks(workers);
  const { workspaces, archivedWorkspaces } = useWorkspaces();
  useAutoIngestReconciler(workers, queuedCountByWorkerId);

  const activeTaskByWorkerId = useMemo(() => {
    const map = new Map<string, WorkerTask>();
    for (const task of allTasks) {
      // waiting_user (#662) still holds the worker's slot.
      if (task.status === 'in_progress' || task.status === 'waiting_user')
        map.set(task.worker_id, task);
    }
    return map;
  }, [allTasks]);

  const workspaceSummaryById = useMemo(() => {
    const map = new Map<string, SidebarWorkspace>();
    for (const ws of [...workspaces, ...archivedWorkspaces]) {
      map.set(ws.id, ws);
    }
    return map;
  }, [workspaces, archivedWorkspaces]);

  // A worker is stalled when its task is in progress but the workspace agent
  // is no longer running (e.g. a pending push kept the task from advancing).
  // `isFinalizing` covers the orchestrator's PR-publishing window (push +
  // adopt/create + on_pr_open) that briefly follows the agent stopping while
  // the DB task is still `in_progress` — without it the WorkerCard flashes
  // "stalled" between agent-done and task→in_review (issue #493).
  const stalledWorkerIds = useMemo(() => {
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const stalled = new Set<string>();
    for (const worker of workers) {
      if (!worker.active_workspace_id) continue;
      const task = activeTaskByWorkerId.get(worker.id);
      const ws = workspaceById.get(worker.active_workspace_id);
      if (
        task &&
        task.status === 'in_progress' &&
        ws &&
        !ws.isRunning &&
        !ws.hasPendingApproval &&
        !ws.hasTaskInReview &&
        !ws.isFinalizing &&
        ws.latestProcessStatus !== 'running'
      ) {
        stalled.add(worker.id);
      }
    }
    return stalled;
  }, [workers, workspaces, activeTaskByWorkerId]);

  const inReviewWorkerIds = useMemo(() => {
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const inReview = new Set<string>();
    for (const worker of workers) {
      if (!worker.active_workspace_id) continue;
      const ws = workspaceById.get(worker.active_workspace_id);
      if (ws?.hasTaskInReview && !ws.hasPendingApproval) {
        inReview.add(worker.id);
      }
    }
    return inReview;
  }, [workers, workspaces]);

  // In-review PRs whose review has not been dispatched only because CI is
  // still running — shown on idle reviewer cards so "free" reads as "waiting".
  const waitingCiPrs = useMemo(
    () =>
      workspaces
        .filter(
          (ws) =>
            ws.hasTaskInReview &&
            ws.prNumber != null &&
            reviewGate({
              ciStatus: ws.prCiStatus,
              reviewActivity: ws.prReviewActivity,
              authorWorking: ws.isRunning,
            }) === 'waiting_ci'
        )
        .map((ws) => ({
          prNumber: ws.prNumber as number,
          title: ws.taskTitle ?? ws.name,
        })),
    [workspaces]
  );

  const approvedWorkerIds = useMemo(() => {
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const approved = new Set<string>();
    for (const worker of workers) {
      if (!worker.active_workspace_id) continue;
      const ws = workspaceById.get(worker.active_workspace_id);
      if (ws?.hasTaskApproved && !ws.hasPendingApproval) {
        approved.add(worker.id);
      }
    }
    return approved;
  }, [workers, workspaces]);

  const workingWorkerIds = useMemo(
    () => new Set(activeTaskByWorkerId.keys()),
    [activeTaskByWorkerId]
  );

  const waitingApprovalWorkerIds = useMemo(() => {
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const waiting = new Set<string>();
    for (const worker of workers) {
      if (!worker.active_workspace_id) continue;
      const ws = workspaceById.get(worker.active_workspace_id);
      if (ws?.hasPendingApproval) waiting.add(worker.id);
    }
    return waiting;
  }, [workers, workspaces]);

  const stats = useMemo(() => {
    const working = workers.filter(
      (w) => w.active_workspace_id !== null
    ).length;
    const totalQueued = workers.reduce(
      (sum, w) => sum + (queuedCountByWorkerId.get(w.id) ?? 0),
      0
    );
    const totalCompleted = workers.reduce(
      (sum, w) => sum + w.completed_count,
      0
    );
    return { working, totalQueued, totalCompleted };
  }, [workers, queuedCountByWorkerId]);

  const [filters, setFilters] = useState<WorkersFilterState>(() =>
    emptyFilterState()
  );

  const filtersActive = isFilterActive(filters);

  const visibleWorkers = useMemo(() => {
    if (!filtersActive) return workers;
    const query = filters.search.trim().toLowerCase();
    return workers.filter((worker) => {
      if (query && !worker.name.toLowerCase().includes(query)) return false;
      if (filters.role.size > 0) {
        const role = worker.role ?? 'developer';
        if (!filters.role.has(role)) return false;
      }
      if (filters.model.size > 0) {
        const bucket = bucketForModel(worker.model);
        if (!bucket || !filters.model.has(bucket)) return false;
      }
      if (filters.status.size > 0) {
        const status = deriveWorkerStatus(worker, {
          needsAttention: stalledWorkerIds.has(worker.id),
          inReview: inReviewWorkerIds.has(worker.id),
          approved: approvedWorkerIds.has(worker.id),
          isWaitingApproval: waitingApprovalWorkerIds.has(worker.id),
        });
        if (!filters.status.has(status)) return false;
      }
      return true;
    });
  }, [
    filtersActive,
    workers,
    filters,
    stalledWorkerIds,
    inReviewWorkerIds,
    approvedWorkerIds,
    waitingApprovalWorkerIds,
  ]);

  const visibleWorkerIds = useMemo(
    () => (filtersActive ? new Set(visibleWorkers.map((w) => w.id)) : null),
    [filtersActive, visibleWorkers]
  );

  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null);
  const [duplicatingWorkerIds, setDuplicatingWorkerIds] = useState<Set<string>>(
    () => new Set()
  );
  const [restoringWorkerId, setRestoringWorkerId] = useState<string | null>(
    null
  );
  const [purgingWorkerId, setPurgingWorkerId] = useState<string | null>(null);
  const [isPurgingAllArchived, setIsPurgingAllArchived] = useState(false);

  const handleStartNext = async (worker: WorkerResponse) => {
    setStartingWorkerId(worker.id);
    try {
      const task = await startMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.startSuccess', {
          worker: worker.name,
          title: task.title,
        })
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Plan concurrent-agents cap reached — the task is still queued and
        // will start as soon as capacity frees up. Frame it as a fila, not a
        // pared, and surface the upsell CTA when one is configured.
        const limit = planLimits?.concurrent_agents_limit;
        pushToast(
          'info',
          limit != null
            ? t('workers.toast.planCapReachedWithLimit', {
                worker: worker.name,
                limit,
              })
            : t('workers.toast.planCapReached', { worker: worker.name }),
          planLimits?.upgrade_cta ? { cta: planLimits.upgrade_cta } : undefined
        );
      } else if (err instanceof ApiError && err.status === 409) {
        const serverMessage =
          err.message &&
          err.message !== 'API request failed' &&
          !err.message.startsWith('Request failed with status')
            ? err.message
            : null;
        pushToast(
          serverMessage ? 'error' : 'info',
          serverMessage ??
            t('workers.toast.startConflict', { worker: worker.name })
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        pushToast(
          'error',
          t('workers.toast.startError', { worker: worker.name, message })
        );
      }
    } finally {
      setStartingWorkerId(null);
    }
  };

  const handleDuplicate = async (worker: WorkerResponse) => {
    if (duplicatingWorkerIds.has(worker.id)) return;
    setDuplicatingWorkerIds((prev) => {
      const next = new Set(prev);
      next.add(worker.id);
      return next;
    });
    try {
      const clone = await duplicateMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.duplicateSuccess', {
          worker: worker.name,
          clone: clone.name,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(
        'error',
        t('workers.toast.duplicateError', {
          worker: worker.name,
          message,
        })
      );
    } finally {
      setDuplicatingWorkerIds((prev) => {
        const next = new Set(prev);
        next.delete(worker.id);
        return next;
      });
    }
  };

  const handleArchive = async (worker: WorkerResponse) => {
    try {
      await archiveMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.archiveSuccess', { worker: worker.name })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(
        'error',
        t('workers.toast.archiveError', { worker: worker.name, message })
      );
    }
  };

  const handleUnarchive = async (worker: WorkerResponse) => {
    setRestoringWorkerId(worker.id);
    try {
      await unarchiveMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.unarchiveSuccess', { worker: worker.name })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(
        'error',
        t('workers.toast.unarchiveError', { worker: worker.name, message })
      );
    } finally {
      setRestoringWorkerId(null);
    }
  };

  const handlePurge = async (worker: WorkerResponse) => {
    const result = await ConfirmDialog.show({
      title: t('workers.purge'),
      message: t('workers.purge_confirm', { worker: worker.name }),
      confirmText: t('workers.purge'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;

    setPurgingWorkerId(worker.id);
    try {
      await deleteMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.purgeSuccess', { worker: worker.name })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(
        'error',
        t('workers.toast.purgeError', { worker: worker.name, message })
      );
    } finally {
      setPurgingWorkerId(null);
    }
  };

  const handlePurgeAllArchived = async () => {
    const count = archivedWorkers.length;
    if (count === 0) return;
    const result = await ConfirmDialog.show({
      title: t('workers.purge_all'),
      message: t('workers.purge_all_confirm', { count }),
      confirmText: t('workers.purge_all'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;

    setIsPurgingAllArchived(true);
    try {
      const { deleted } = await deleteAllArchivedMutation.mutateAsync();
      pushToast(
        'success',
        t('workers.toast.purgeAllSuccess', { count: deleted })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast('error', t('workers.toast.purgeAllError', { message }));
    } finally {
      setIsPurgingAllArchived(false);
    }
  };

  const handleNewWorker = async () => {
    const result = await WorkerFormDialog.show({});
    if (result === 'saved') {
      pushToast('success', t('workers.toast.createSuccess'));
    }
  };

  const handleEditWorker = async (worker: WorkerResponse) => {
    try {
      const result = await WorkerFormDialog.show({ worker });
      if (result === 'saved') {
        pushToast('success', t('workers.toast.updateSuccess'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast('error', message);
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <ShellSidebarPortal>
        <WorkersSidebar
          workers={workers}
          archivedWorkers={archivedWorkers}
          workingWorkerIds={workingWorkerIds}
          attentionWorkerIds={stalledWorkerIds}
          visibleWorkerIds={visibleWorkerIds}
        />
      </ShellSidebarPortal>
      <PageHeader
        title={t('workers.title')}
        actions={
          <Button
            variant="primary"
            size="sm"
            className="h-8 gap-1.5 text-sm"
            onClick={handleNewWorker}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t('workers.newWorker')}
          </Button>
        }
      />

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="px-container-padding pt-4 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={cn(
                'flex items-start justify-between gap-3 rounded-xl border border-border-strong bg-card px-3 py-2 text-sm shadow-overlay',
                toast.variant === 'success'
                  ? 'text-success'
                  : toast.variant === 'error'
                    ? 'text-error'
                    : 'text-high'
              )}
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
                title={t('workers.toast.dismiss')}
                className="shrink-0 rounded-sm p-0.5 text-normal transition-colors hover:bg-secondary hover:text-high"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Bento stats */}
      {workers.length > 0 && !isLoading && !isError && (
        <div className="grid grid-cols-3 gap-4 px-container-padding pt-4 pb-4">
          <StatCard
            label={t('workers.stats.working')}
            value={stats.working}
            icon={Zap}
          />
          <StatCard
            label={t('workers.stats.queued')}
            value={stats.totalQueued}
            icon={Clock3}
          />
          <StatCard
            label={t('workers.stats.completed')}
            value={stats.totalCompleted}
            icon={CheckCircle2}
          />
        </div>
      )}

      {/* Filter bar — only meaningful once at least one worker exists */}
      {workers.length > 0 && !isLoading && !isError && (
        <WorkersFilterBar
          filters={filters}
          onChange={setFilters}
          visibleCount={visibleWorkers.length}
          totalCount={workers.length}
        />
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-normal">
            <Loader2
              className="h-4 w-4 animate-spin text-brand-on-surface"
              strokeWidth={1.75}
            />
            <span className="text-sm">{t('workers.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-4 text-body-md text-md-error">
            {t('workers.loadError')}
          </div>
        ) : workers.length === 0 ? (
          <div className="flex h-full">
            <WorkersEmptyState onCreateWorker={handleNewWorker} />
          </div>
        ) : visibleWorkers.length === 0 ? (
          <WorkersFilterEmptyState
            onClearFilters={() => setFilters(emptyFilterState())}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,380px))] gap-4 p-container-padding">
            {visibleWorkers.map((worker) => (
              <div key={worker.id} id={workerCardDomId(worker.id)}>
                <WorkerCard
                  worker={worker}
                  queuedCount={queuedCountByWorkerId.get(worker.id) ?? 0}
                  activeTask={activeTaskByWorkerId.get(worker.id)}
                  needsAttention={stalledWorkerIds.has(worker.id)}
                  inReview={inReviewWorkerIds.has(worker.id)}
                  approved={approvedWorkerIds.has(worker.id)}
                  modelName={
                    worker.model ? modelNameById.get(worker.model) : undefined
                  }
                  waitingCiPrs={
                    worker.role === 'reviewer' ? waitingCiPrs : undefined
                  }
                  activeWorkspace={
                    worker.active_workspace_id
                      ? workspaceSummaryById.get(worker.active_workspace_id)
                      : undefined
                  }
                  isStarting={startingWorkerId === worker.id}
                  isDuplicating={duplicatingWorkerIds.has(worker.id)}
                  onStartNext={() => handleStartNext(worker)}
                  onEdit={() => handleEditWorker(worker)}
                  onDuplicate={() => handleDuplicate(worker)}
                  onArchive={() => handleArchive(worker)}
                />
              </div>
            ))}
          </div>
        )}
        <ArchivedWorkersSection
          workers={archivedWorkers}
          isLoading={isArchivedLoading}
          isError={isArchivedError}
          restoringWorkerId={restoringWorkerId}
          purgingWorkerId={purgingWorkerId}
          isPurgingAll={isPurgingAllArchived}
          onRestore={handleUnarchive}
          onPurge={handlePurge}
          onPurgeAll={handlePurgeAllArchived}
        />
      </div>
    </div>
  );
}
