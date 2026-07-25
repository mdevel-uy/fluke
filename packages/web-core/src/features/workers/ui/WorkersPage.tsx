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
import { ApiError } from '@/shared/lib/api';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { cn } from '@/shared/lib/utils';
import {
  useDeleteWorker,
  useDuplicateWorker,
  useStartNextWorkerTask,
  useWorkers,
} from '@/features/workers/model/useWorkers';
import { useAllWorkerTasks } from '@/features/sprint/model/useWorkers';
import { useAutoIngestReconciler } from '@/features/sprint/model/useAutoIngestReconciler';
import type { WorkerTask } from '@/features/sprint/types';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { WorkerCard } from './WorkerCard';
import { WorkersEmptyState } from './WorkersEmptyState';
import { WorkerFormDialog } from './WorkerFormDialog';

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
};

const TOAST_DURATION_MS = 4000;

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

export function WorkersPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('workers.title'));

  const { data: workers = [], isLoading, isError } = useWorkers();
  const startMutation = useStartNextWorkerTask();
  const deleteMutation = useDeleteWorker();
  const duplicateMutation = useDuplicateWorker();
  const { tasks: allTasks, queuedCountByWorkerId } = useAllWorkerTasks(workers);
  const { workspaces, archivedWorkspaces } = useWorkspaces();
  useAutoIngestReconciler(workers, queuedCountByWorkerId);

  const activeTaskByWorkerId = useMemo(() => {
    const map = new Map<string, WorkerTask>();
    for (const task of allTasks) {
      if (task.status === 'in_progress') map.set(task.worker_id, task);
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
  const stalledWorkerIds = useMemo(() => {
    const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
    const stalled = new Set<string>();
    for (const worker of workers) {
      if (!worker.active_workspace_id) continue;
      const task = activeTaskByWorkerId.get(worker.id);
      const ws = workspaceById.get(worker.active_workspace_id);
      if (
        task &&
        ws &&
        !ws.isRunning &&
        !ws.hasPendingApproval &&
        ws.latestProcessStatus !== 'running'
      ) {
        stalled.add(worker.id);
      }
    }
    return stalled;
  }, [workers, workspaces, activeTaskByWorkerId]);

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

  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null);
  const [duplicatingWorkerIds, setDuplicatingWorkerIds] = useState<Set<string>>(
    () => new Set()
  );

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
      if (err instanceof ApiError && err.status === 409) {
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

  const handleDelete = async (worker: WorkerResponse) => {
    const confirmed = window.confirm(
      t('workers.confirmDelete', { worker: worker.name })
    );
    if (!confirmed) return;
    try {
      await deleteMutation.mutateAsync(worker.id);
      pushToast(
        'success',
        t('workers.toast.deleteSuccess', { worker: worker.name })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast('error', message);
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
    <div className="flex h-full w-full flex-col bg-md-background">
      {/* MD3 top bar */}
      <header className="flex items-center justify-between px-container-padding border-b border-md-outline-variant gap-4 h-16 shrink-0 bg-md-surface-bright">
        <h1 className="text-heading font-sans text-high">
          {t('workers.title')}
        </h1>
        <Button variant="primary" onClick={handleNewWorker}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {t('workers.newWorker')}
        </Button>
      </header>

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
              <span className="min-w-0 flex-1 leading-relaxed">
                {toast.message}
              </span>
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
        <div className="grid grid-cols-3 gap-4 px-container-padding pt-4">
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
        ) : (
          <div className="grid grid-cols-1 gap-4 p-container-padding md:grid-cols-2 xl:grid-cols-3">
            {workers.map((worker) => (
              <WorkerCard
                key={worker.id}
                worker={worker}
                queuedCount={queuedCountByWorkerId.get(worker.id) ?? 0}
                activeTask={activeTaskByWorkerId.get(worker.id)}
                needsAttention={stalledWorkerIds.has(worker.id)}
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
                onDelete={() => handleDelete(worker)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
