import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { ApiError } from '@/shared/lib/api';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { cn } from '@/shared/lib/utils';
import {
  useDeleteWorker,
  useStartNextWorkerTask,
  useWorkers,
} from '@/features/workers/model/useWorkers';
import { WorkerCard } from './WorkerCard';
import { WorkersEmptyState } from './WorkersEmptyState';
import { WorkerFormDialog } from './WorkerFormDialog';

function StatCard({
  label,
  value,
  materialIcon,
  accentClass,
}: {
  label: string;
  value: number;
  materialIcon: string;
  accentClass: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-md-outline-variant bg-md-surface-container-low p-4">
      <div
        className={cn(
          'flex items-center gap-1.5 text-label-caps font-geist font-semibold uppercase tracking-widest',
          accentClass
        )}
      >
        <MaterialIcon name={materialIcon} size="sm" />
        <span>{label}</span>
      </div>
      <p className="text-display-lg font-sans font-bold text-md-on-surface tabular-nums leading-none">
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

  const stats = useMemo(() => {
    const working = workers.filter(
      (w) => w.active_workspace_id !== null
    ).length;
    const totalQueued = workers.reduce((sum, w) => sum + w.queued_count, 0);
    const totalCompleted = workers.reduce(
      (sum, w) => sum + w.completed_count,
      0
    );
    return { working, totalQueued, totalCompleted };
  }, [workers]);

  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null);

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
        <h1 className="text-headline-md font-sans font-semibold text-md-primary tracking-tight">
          {t('workers.title')}
        </h1>
        <button
          type="button"
          onClick={handleNewWorker}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-lg',
            'bg-md-primary text-md-on-primary text-body-sm font-semibold',
            'hover:opacity-90 active:scale-95 transition-all duration-200 shadow-soft'
          )}
        >
          <MaterialIcon name="add" size="sm" />
          {t('workers.newWorker')}
        </button>
      </header>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="px-container-padding pt-4 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={cn(
                'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-body-sm',
                toast.variant === 'success'
                  ? 'border-success/30 bg-success/10 text-success'
                  : toast.variant === 'error'
                    ? 'border-md-error/30 bg-md-error/10 text-md-error'
                    : 'border-md-outline-variant bg-md-surface-container-low text-md-on-surface'
              )}
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

      {/* Bento stats */}
      {workers.length > 0 && !isLoading && !isError && (
        <div className="grid grid-cols-3 gap-4 px-container-padding pt-4">
          <StatCard
            label={t('workers.stats.working')}
            value={stats.working}
            materialIcon="electric_bolt"
            accentClass="text-success"
          />
          <StatCard
            label={t('workers.stats.queued')}
            value={stats.totalQueued}
            materialIcon="schedule"
            accentClass="text-warning"
          />
          <StatCard
            label={t('workers.stats.completed')}
            value={stats.totalCompleted}
            materialIcon="check_circle"
            accentClass="text-md-primary"
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-md-on-surface-variant">
            <MaterialIcon
              name="progress_activity"
              size="base"
              className="animate-spin text-md-primary"
            />
            <span className="text-body-md">{t('workers.loading')}</span>
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
          <div className="grid grid-cols-1 gap-5 p-container-padding md:grid-cols-2 xl:grid-cols-3">
            {workers.map((worker) => (
              <WorkerCard
                key={worker.id}
                worker={worker}
                isStarting={startingWorkerId === worker.id}
                onStartNext={() => handleStartNext(worker)}
                onEdit={() => handleEditWorker(worker)}
                onDelete={() => handleDelete(worker)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
