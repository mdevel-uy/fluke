import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  CircleNotchIcon,
  PlusIcon,
  QueueIcon,
  SpinnerIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { WorkerResponse } from 'shared/types';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { ApiError } from '@/shared/lib/api';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
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
  icon: Icon,
  accent,
}: {
  label: string;
  value: number;
  icon: FC<{ className?: string; weight?: string }>;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-half rounded-lg border border-border bg-secondary p-base">
      <div className={`flex items-center gap-half text-xs font-medium ${accent}`}>
        <Icon className="size-icon-sm" weight="bold" />
        <span>{label}</span>
      </div>
      <p className="text-xl font-bold text-high">{value}</p>
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
    const working = workers.filter((w) => w.active_workspace_id !== null).length;
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
        pushToast(
          'info',
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
    const result = await WorkerFormDialog.show({ worker });
    if (result === 'saved') {
      pushToast('success', t('workers.toast.updateSuccess'));
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <header className="flex items-center justify-between px-double py-base border-b border-border gap-base">
        <div className="flex items-baseline gap-base min-w-0">
          <h1 className="text-lg font-semibold text-high">
            {t('workers.title')}
          </h1>
          {workers.length > 0 && (
            <span className="text-sm text-low">
              {t('workers.countLabel', { count: workers.length })}
            </span>
          )}
        </div>
        <PrimaryButton
          variant="default"
          value={t('workers.newWorker')}
          actionIcon={PlusIcon}
          onClick={handleNewWorker}
        />
      </header>

      {toasts.length > 0 && (
        <div className="px-double pt-base flex flex-col gap-1">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={
                'flex items-start justify-between gap-base rounded-md border px-base py-half text-sm ' +
                (toast.variant === 'success'
                  ? 'border-success/40 bg-success/10 text-success'
                  : toast.variant === 'error'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-border bg-secondary text-normal')
              }
            >
              <span className="min-w-0 flex-1">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label={t('workers.toast.dismiss')}
                className="shrink-0 text-low hover:text-normal cursor-pointer"
              >
                <XIcon className="size-icon-sm" weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}

      {workers.length > 0 && !isLoading && !isError && (
        <div className="grid grid-cols-3 gap-base px-double pt-base">
          <StatCard
            label={t('workers.stats.working')}
            value={stats.working}
            icon={CircleNotchIcon}
            accent="text-success"
          />
          <StatCard
            label={t('workers.stats.queued')}
            value={stats.totalQueued}
            icon={QueueIcon}
            accent="text-warning"
          />
          <StatCard
            label={t('workers.stats.completed')}
            value={stats.totalCompleted}
            icon={CheckCircleIcon}
            accent="text-info"
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerIcon className="size-icon-base animate-spin" />
            <span className="text-sm">{t('workers.loading')}</span>
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center px-base text-sm text-error">
            {t('workers.loadError')}
          </div>
        ) : workers.length === 0 ? (
          <div className="flex h-full">
            <WorkersEmptyState onCreateWorker={handleNewWorker} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-base p-double md:grid-cols-2 xl:grid-cols-3">
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
