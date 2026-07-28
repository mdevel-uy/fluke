import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { defineModal } from '@/shared/lib/modals';
import { skillsApi, workersApi } from '@/shared/lib/api';
import { workersKeys } from '@/features/workers';
import { repoIssuesKeys } from '@/features/issues/model/repoIssuesKeys';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import type { ActiveIssueTaskInfo } from '@/shared/lib/api';
import type { WorkerResponse } from 'shared/types';
import type { RepoIssue } from '@/features/issues/types';
import { SkillsPicker } from '@/features/sprint/ui/SkillsPicker';
import { extractSkillLabelNames } from '@/features/sprint/lib/skillLabels';
import { buildAssignToAgentPrompt } from './assignToAgentPrompt';

export interface AssignToAgentDialogProps {
  issue: RepoIssue;
  repoId: string;
}

export type AssignToAgentResult = 'created' | 'canceled';

const AssignToAgentDialogImpl = create<AssignToAgentDialogProps>(
  ({ issue, repoId }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const queryClient = useQueryClient();

    const prompt = useMemo(() => buildAssignToAgentPrompt(issue), [issue]);
    const [workers, setWorkers] = useState<WorkerResponse[]>([]);
    const [loadingWorkers, setLoadingWorkers] = useState(true);
    const [workerLoadError, setWorkerLoadError] = useState(false);
    const [selectedWorkerId, setSelectedWorkerId] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const [conflictInfo, setConflictInfo] =
      useState<ActiveIssueTaskInfo | null>(null);
    const [checkingConflict, setCheckingConflict] = useState(true);
    const [conflictOverridden, setConflictOverridden] = useState(false);

    // Fetch installed skills so the user can attach any subset. The list is
    // small (each entry is a directory under ~/.claude/skills); a fetch on
    // dialog open keeps the picker in sync with recent installs/removals.
    const { data: installedSkills = [] } = useQuery({
      queryKey: ['skills'],
      queryFn: () => skillsApi.list(),
    });
    const labelSkills = useMemo(
      () => extractSkillLabelNames(issue.labels),
      [issue.labels]
    );
    const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
    // Auto-select any `skill:<name>` labels once the installed list has loaded,
    // but only when the user has not already touched the picker (empty state).
    // We keep the dialog controlled but idempotent: switching issues or
    // reopening always re-derives from labels.
    useEffect(() => {
      setSelectedSkills(labelSkills);
    }, [labelSkills]);

    useEffect(() => {
      let cancelled = false;
      setLoadingWorkers(true);
      setWorkerLoadError(false);
      workersApi
        .list()
        .then((data) => {
          if (cancelled) return;
          setWorkers(data);
          if (data.length > 0) setSelectedWorkerId(data[0].id);
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
    }, []);

    useEffect(() => {
      let cancelled = false;
      setCheckingConflict(true);
      workersApi
        .checkActiveIssueTask(repoId, issue.number)
        .then((info) => {
          if (cancelled) return;
          setConflictInfo(info);
        })
        .catch(() => {
          if (cancelled) return;
          // Silently ignore — conflict check is a best-effort guard
        })
        .finally(() => {
          if (cancelled) return;
          setCheckingConflict(false);
        });
      return () => {
        cancelled = true;
      };
    }, [repoId, issue.number]);

    // NiceModal keeps the component mounted after hide(): remove() unmounts
    // so the next show() starts fresh (otherwise isSubmitting/conflict state
    // leak into the second open and the confirm button stays disabled).
    const closeWith = (result: AssignToAgentResult) => {
      modal.resolve(result);
      modal.hide();
      modal.remove();
    };

    const handleCancel = () => {
      closeWith('canceled');
    };

    const handleConfirm = async (forceOverride = false) => {
      const trimmed = prompt.trim();
      if (!trimmed || !selectedWorkerId) return;
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await workersApi.createTask(selectedWorkerId, {
          repo_id: repoId,
          title: `#${issue.number} ${issue.title}`,
          prompt: trimmed,
          issue_number: issue.number,
          skills: selectedSkills,
          ...(forceOverride ? { force_duplicate: true } : {}),
        });
        const invalidateWorkers = () =>
          queryClient.invalidateQueries({ queryKey: workersKeys.all });
        invalidateWorkers();
        queryClient.invalidateQueries({
          queryKey: repoIssuesKeys.byRepo(repoId),
        });
        // With auto-ingest on, kick the worker right away if it is idle.
        const { autoIngest } = useAutoIngestStore.getState();
        const worker = workers.find((w) => w.id === selectedWorkerId);
        if (autoIngest && worker && !worker.active_workspace_id) {
          workersApi
            .startNext(selectedWorkerId)
            .catch(() => {
              // Best-effort: the worker may have picked up another task already.
            })
            .finally(invalidateWorkers);
        }
        closeWith('created');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSubmitError(message);
        setIsSubmitting(false);
      }
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) handleCancel();
    };

    const isLoading = loadingWorkers || checkingConflict;

    const showConflictWarning =
      !isLoading && conflictInfo !== null && !conflictOverridden;

    const canConfirm =
      !isLoading &&
      !isSubmitting &&
      !!selectedWorkerId &&
      !!prompt.trim() &&
      workers.length > 0;

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>
              {t('issues.assignDialog.title', { number: issue.number })}
            </DialogTitle>
            <DialogDescription>
              {t('issues.assignDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {isLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('issues.assignDialog.checkingConflicts')}
              </p>
            ) : showConflictWarning ? (
              <Alert variant="destructive" className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t('issues.assignDialog.duplicateWarning', {
                    number: issue.number,
                    worker: conflictInfo!.worker_name,
                    status: conflictInfo!.status,
                  })}
                </span>
              </Alert>
            ) : null}

            {!showConflictWarning && (
              <div>
                <Label htmlFor="assign-worker-select">
                  {t('issues.assignDialog.workerLabel')}
                </Label>
                {loadingWorkers ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('issues.assignDialog.loadingWorkers')}
                  </p>
                ) : workerLoadError || workers.length === 0 ? (
                  <Alert variant="destructive" className="mt-1">
                    {workerLoadError
                      ? t('issues.assignDialog.workerLoadError')
                      : t('issues.assignDialog.noWorkers')}
                  </Alert>
                ) : (
                  <Select
                    value={selectedWorkerId}
                    onValueChange={setSelectedWorkerId}
                  >
                    <SelectTrigger id="assign-worker-select" className="mt-1">
                      <SelectValue
                        placeholder={t('issues.assignDialog.workerPlaceholder')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {workers.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {!showConflictWarning && (
              <div>
                <Label>{t('issues.assignDialog.skillsLabel')}</Label>
                <div className="mt-1">
                  <SkillsPicker
                    installed={installedSkills}
                    selected={selectedSkills}
                    onChange={setSelectedSkills}
                    disabled={isSubmitting}
                    emptyHint={t('issues.assignDialog.skillsEmpty')}
                    triggerLabel={t('issues.assignDialog.skillsPicker')}
                  />
                </div>
              </div>
            )}

            {submitError && (
              <Alert variant="destructive">
                {t('issues.assignDialog.enqueuedError')}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              {t('issues.assignDialog.cancel')}
            </Button>
            {showConflictWarning ? (
              <Button
                variant="destructive"
                onClick={() => {
                  setConflictOverridden(true);
                }}
                disabled={isSubmitting}
              >
                {t('issues.assignDialog.assignAnyway')}
              </Button>
            ) : (
              <Button
                onClick={() => handleConfirm(conflictOverridden)}
                disabled={!canConfirm}
              >
                {isSubmitting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t('issues.assignDialog.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const AssignToAgentDialog = defineModal<
  AssignToAgentDialogProps,
  AssignToAgentResult
>(AssignToAgentDialogImpl);
