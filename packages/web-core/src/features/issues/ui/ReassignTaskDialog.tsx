import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Label } from '@vibe/ui/components/Label';
import { Alert } from '@vibe/ui/components/Alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { defineModal } from '@/shared/lib/modals';
import { workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers';
import { repoIssuesKeys } from '@/features/issues/model/repoIssuesKeys';
import type { WorkerResponse } from 'shared/types';
import type { WorkerTask } from '@/features/sprint/types';
import { WorkerSelectItem } from './WorkerSelectItem';

export interface ReassignTaskDialogProps {
  task: WorkerTask;
  repoId: string;
  issueNumber: number;
  issueTitle: string;
}

export type ReassignTaskResult = 'reassigned' | 'canceled';

const ReassignTaskDialogImpl = create<ReassignTaskDialogProps>(
  ({ task, repoId, issueNumber, issueTitle }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const queryClient = useQueryClient();

    const [workers, setWorkers] = useState<WorkerResponse[]>([]);
    const [loadingWorkers, setLoadingWorkers] = useState(true);
    const [workerLoadError, setWorkerLoadError] = useState(false);
    const [selectedWorkerId, setSelectedWorkerId] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    // Only queued tasks can be reassigned atomically. For any other status
    // we block the confirm button and explain why (matches AC: "reglas
    // explícitas para tareas in_progress").
    const isQueued = task.status === 'queued';

    useEffect(() => {
      let cancelled = false;
      setLoadingWorkers(true);
      setWorkerLoadError(false);
      workersApi
        .list()
        .then((data) => {
          if (cancelled) return;
          setWorkers(data);
          const firstOther = data.find((w) => w.id !== task.worker_id);
          if (firstOther) setSelectedWorkerId(firstOther.id);
        })
        .catch(() => {
          if (cancelled) return;
          setWorkerLoadError(true);
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingWorkers(false);
        });
      return () => {
        cancelled = true;
      };
    }, [task.worker_id]);

    const currentWorker = useMemo(
      () => workers.find((w) => w.id === task.worker_id),
      [workers, task.worker_id]
    );
    const otherWorkers = useMemo(
      () => workers.filter((w) => w.id !== task.worker_id),
      [workers, task.worker_id]
    );

    // remove() unmounts after hide so the next show() starts with fresh
    // state (NiceModal keeps hidden modals mounted by default).
    const closeWith = (result: ReassignTaskResult) => {
      modal.resolve(result);
      modal.hide();
      modal.remove();
    };

    const handleCancel = () => {
      closeWith('canceled');
    };

    const handleConfirm = async () => {
      if (!selectedWorkerId || !isQueued) return;
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await workersApi.reassignTask(
          task.worker_id,
          task.id,
          selectedWorkerId
        );
        queryClient.invalidateQueries({ queryKey: workersKeys.all });
        queryClient.invalidateQueries({
          queryKey: repoIssuesKeys.byRepo(repoId),
        });
        closeWith('reassigned');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSubmitError(message);
        setIsSubmitting(false);
      }
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) handleCancel();
    };

    const canConfirm =
      isQueued &&
      !loadingWorkers &&
      !isSubmitting &&
      !!selectedWorkerId &&
      otherWorkers.length > 0;

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {t('issues.reassignDialog.title', { number: issueNumber })}
            </DialogTitle>
            <DialogDescription>
              {t('issues.reassignDialog.description', { title: issueTitle })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {!isQueued && (
              <Alert variant="destructive" className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t('issues.reassignDialog.notQueuedWarning', {
                    status: t(`issues.taskStatus.${task.status}`, {
                      defaultValue: task.status,
                    }),
                  })}
                </span>
              </Alert>
            )}

            <div className="text-xs text-low">
              {t('issues.reassignDialog.currentWorker')}{' '}
              <span className="text-normal">
                {currentWorker
                  ? `${currentWorker.emoji} ${currentWorker.name}`
                  : t('issues.reassignDialog.unknownWorker')}
              </span>
            </div>

            {isQueued && (
              <div>
                <Label htmlFor="reassign-worker-select">
                  {t('issues.reassignDialog.targetWorkerLabel')}
                </Label>
                {loadingWorkers ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('issues.assignDialog.loadingWorkers')}
                  </p>
                ) : workerLoadError ? (
                  <Alert variant="destructive" className="mt-1">
                    {t('issues.assignDialog.workerLoadError')}
                  </Alert>
                ) : otherWorkers.length === 0 ? (
                  <Alert variant="destructive" className="mt-1">
                    {t('issues.reassignDialog.noOtherWorkers')}
                  </Alert>
                ) : (
                  <Select
                    value={selectedWorkerId}
                    onValueChange={setSelectedWorkerId}
                  >
                    <SelectTrigger id="reassign-worker-select" className="mt-1">
                      <SelectValue
                        placeholder={t('issues.assignDialog.workerPlaceholder')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {otherWorkers.map((w) => (
                        <WorkerSelectItem key={w.id} worker={w} showEmoji />
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {submitError && (
              <Alert variant="destructive">
                {t('issues.reassignDialog.reassignError')}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              {t('issues.assignDialog.cancel')}
            </Button>
            <Button onClick={handleConfirm} disabled={!canConfirm}>
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('issues.reassignDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const ReassignTaskDialog = defineModal<
  ReassignTaskDialogProps,
  ReassignTaskResult
>(ReassignTaskDialogImpl);
