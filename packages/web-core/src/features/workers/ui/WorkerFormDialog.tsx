import { useEffect, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Textarea } from '@vibe/ui/components/Textarea';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import type { WorkerResponse } from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import type { CreateWorkerRequest } from '@/shared/lib/api';
import {
  useBaseInstructions,
  useCreateWorker,
  useUpdateWorker,
} from '@/features/workers/model/useWorkers';
import {
  SOUL_TEMPLATES,
  type SoulTemplateId,
} from '@/features/workers/model/soulTemplates';

export const WORKER_ROLES = ['developer', 'analyst', 'reviewer'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export interface WorkerFormDialogProps {
  worker?: WorkerResponse;
}

export type WorkerFormResult = 'saved' | 'canceled';

const WorkerFormDialogImpl = create<WorkerFormDialogProps>(({ worker }) => {
  const modal = useModal();
  const { t } = useTranslation('common');
  const isEdit = !!worker;

  const [name, setName] = useState(worker?.name ?? '');
  const [emoji, setEmoji] = useState(worker?.emoji ?? '🤖');
  const [soul, setSoul] = useState(worker?.soul ?? '');
  const [role, setRole] = useState<WorkerRole>(
    (worker?.role as WorkerRole) ?? 'developer'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [baseInstructionsExpanded, setBaseInstructionsExpanded] =
    useState(false);
  const { data: baseInstructions } = useBaseInstructions();

  const createMutation = useCreateWorker();
  const updateMutation = useUpdateWorker();
  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    setErrorMessage(null);
  }, [name, emoji, soul, role]);

  const applyTemplate = (templateId: SoulTemplateId) => {
    const template = SOUL_TEMPLATES.find((tpl) => tpl.id === templateId);
    if (!template) return;
    setSoul(template.soul);
    if (!emoji || emoji === '🤖') setEmoji(template.emoji);
  };

  const handleCancel = () => {
    modal.resolve('canceled' as WorkerFormResult);
    modal.hide();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) handleCancel();
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedEmoji = emoji.trim();
    const trimmedSoul = soul.trim();
    if (!trimmedName || !trimmedEmoji || !trimmedSoul) return;

    const payload: CreateWorkerRequest = {
      name: trimmedName,
      emoji: trimmedEmoji,
      soul: trimmedSoul,
      role,
    };

    try {
      if (isEdit && worker) {
        await updateMutation.mutateAsync({
          workerId: worker.id,
          data: payload,
        });
      } else {
        await createMutation.mutateAsync(payload);
      }
      modal.resolve('saved' as WorkerFormResult);
      modal.hide();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
    }
  };

  const canSubmit =
    name.trim().length > 0 &&
    emoji.trim().length > 0 &&
    soul.trim().length > 0 &&
    !isSubmitting;

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('workers.form.editTitle') : t('workers.form.newTitle')}
          </DialogTitle>
          <DialogDescription>{t('workers.form.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <Label htmlFor="worker-name">{t('workers.form.nameLabel')}</Label>
              <Input
                id="worker-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('workers.form.namePlaceholder')}
                autoFocus
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="worker-emoji">
                {t('workers.form.emojiLabel')}
              </Label>
              <Input
                id="worker-emoji"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                maxLength={4}
                className="mt-1 text-center text-lg"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="worker-role">{t('workers.form.roleLabel')}</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as WorkerRole)}
            >
              <SelectTrigger id="worker-role" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKER_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`workers.roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-low">
              {t(`workers.roles.${role}Description`)}
            </p>
          </div>

          {!isEdit && (
            <div>
              <p className="text-xs text-low mb-1">
                {t('workers.form.templatesLabel')}
              </p>
              <div className="flex flex-wrap gap-2">
                {SOUL_TEMPLATES.map((tpl) => (
                  <Button
                    key={tpl.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => applyTemplate(tpl.id)}
                  >
                    <span className="mr-1">{tpl.emoji}</span>
                    {t(tpl.labelKey)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded border">
            <button
              type="button"
              onClick={() => setBaseInstructionsExpanded((prev) => !prev)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-low hover:text-normal"
            >
              {baseInstructionsExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <span className="font-medium">
                {t('workers.form.systemInstructionsTitle')}
              </span>
              <span className="ml-1 text-low">
                {t('workers.form.systemInstructionsReadOnly')}
              </span>
            </button>
            {baseInstructionsExpanded && (
              <pre className="max-h-48 overflow-auto border-t px-3 py-2 font-mono text-xs text-low whitespace-pre-wrap">
                {baseInstructions ?? '…'}
              </pre>
            )}
          </div>

          <div>
            <Label htmlFor="worker-soul">{t('workers.form.soulLabel')}</Label>
            <Textarea
              id="worker-soul"
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
              rows={14}
              className="mt-1 font-mono text-sm"
              placeholder={t('workers.form.soulPlaceholder')}
            />
          </div>

          {errorMessage && <Alert variant="destructive">{errorMessage}</Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('workers.form.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? t('workers.form.saveEdit') : t('workers.form.saveNew')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const WorkerFormDialog = defineModal<
  WorkerFormDialogProps,
  WorkerFormResult
>(WorkerFormDialogImpl);
