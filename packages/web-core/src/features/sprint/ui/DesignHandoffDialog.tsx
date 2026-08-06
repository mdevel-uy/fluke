import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
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
import { Textarea } from '@vibe/ui/components/Textarea';
import { defineModal } from '@/shared/lib/modals';
import { ApiError } from '@/shared/lib/api';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useCreateDesignHandoff } from '@/features/workers/model/useDesignHandoffs';
import { WorkerSelectItem } from '@/features/issues/ui/WorkerSelectItem';
import type { WorkerTask } from '@/features/sprint/types';
import { taskDisplayTitle } from './IssueBadge';

export interface DesignHandoffDialogProps {
  task: WorkerTask;
}

export type DesignHandoffResult = 'created' | 'canceled';

/**
 * Hand a finished designer deliverable to an analyst. The human only picks
 * the destination (and optionally adds PM guidance); the prompt itself is
 * composed server-side from the handoff template — reference + summary +
 * fetch recipe — so the contract is guaranteed by the system, not the UI.
 */
const DesignHandoffDialogImpl = create<DesignHandoffDialogProps>(({ task }) => {
  const modal = useModal();
  const { t } = useTranslation('common');

  const { data: workers = [], isLoading } = useWorkers();
  const analysts = useMemo(
    () => workers.filter((w) => w.role === 'analyst' && !w.archived),
    [workers]
  );

  const [selectedWorkerId, setSelectedWorkerId] = useState<string>('');
  const selectedId = selectedWorkerId || (analysts[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createHandoff = useCreateDesignHandoff();

  const closeWith = (result: DesignHandoffResult) => {
    modal.resolve(result);
    void modal.hide();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) closeWith('canceled');
  };

  const handleConfirm = async () => {
    if (!selectedId) return;
    setSubmitError(null);
    try {
      await createHandoff.mutateAsync({
        sourceTaskId: task.id,
        workerId: selectedId,
        note: note.trim() || undefined,
        source: 'kanban',
      });
      closeWith('created');
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : String(err);
      setSubmitError(message);
    }
  };

  const canConfirm = !isLoading && !createHandoff.isPending && !!selectedId;

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('sprint.designHandoff.dialogTitle')}</DialogTitle>
          <DialogDescription>{taskDisplayTitle(task)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t('sprint.designHandoff.dialogTarget')}</Label>
            {!isLoading && analysts.length === 0 ? (
              <p className="text-sm text-low">
                {t('sprint.designHandoff.noAnalysts')}
              </p>
            ) : (
              <Select value={selectedId} onValueChange={setSelectedWorkerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {analysts.map((worker) => (
                    <WorkerSelectItem
                      key={worker.id}
                      worker={worker}
                      showEmoji
                    />
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {(task.deliverable_ref || task.result_summary) && (
            <div className="flex flex-col gap-2 rounded-lg border border-md-outline-variant bg-md-surface-container-low px-3 py-2.5">
              {task.deliverable_ref && (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-pink">
                  <span aria-hidden>◈</span>
                  <span className="truncate">{task.deliverable_ref}</span>
                </span>
              )}
              {task.result_summary && (
                <p className="line-clamp-6 whitespace-pre-line text-xs leading-relaxed text-normal">
                  {task.result_summary}
                </p>
              )}
              <p className="text-[11px] leading-snug text-low">
                {t('sprint.designHandoff.composeHint')}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>{t('sprint.designHandoff.noteLabel')}</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('sprint.designHandoff.notePlaceholder')}
              rows={3}
              className="resize-y"
            />
          </div>

          {submitError && <Alert variant="destructive">{submitError}</Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => closeWith('canceled')}>
            {t('buttons.cancel')}
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={!canConfirm}>
            {createHandoff.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t('sprint.designHandoff.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const DesignHandoffDialog = defineModal<
  DesignHandoffDialogProps,
  DesignHandoffResult
>(DesignHandoffDialogImpl);
