import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import type { Worker, WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';
import { SkillChips } from './SkillChips';
import { IngestErrorNote } from './IngestErrorNote';
import { DesignHandoffDialog } from './DesignHandoffDialog';
import { DesignArtifactLinks } from './DesignArtifactLinks';

interface DoneTaskCardProps {
  task: WorkerTask;
  /** Owning worker; unlocks the designer handoff block when role=designer. */
  worker?: Worker;
  isBusy: boolean;
  onRemove: () => void;
}

export function DoneTaskCard({
  task,
  worker,
  isBusy,
  onRemove,
}: DoneTaskCardProps) {
  const { t } = useTranslation('common');
  const [isConfirming, setIsConfirming] = useState(false);

  // A designer deliverable exists when the orchestrator persisted a summary
  // or a pushed ref for this task; only then does the handoff block render.
  const hasDeliverable =
    worker?.role === 'designer' &&
    (task.deliverable_ref != null || task.result_summary != null);
  const handoff = task.handoff ?? null;

  const handleRemoveClick = () => {
    setIsConfirming(true);
  };

  const handleConfirm = () => {
    setIsConfirming(false);
    onRemove();
  };

  const handleCancelConfirm = () => {
    setIsConfirming(false);
  };

  return (
    <article className="group flex flex-col gap-2 p-3.5 bg-md-surface-container-lowest/60 border border-md-outline-variant/50 rounded-lg">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success shrink-0"
          aria-hidden
        >
          <MaterialIcon name="check" size="xs" />
        </span>
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} className="mt-px" />
        )}
        <p
          className="text-body-sm font-sans text-md-on-surface-variant font-medium leading-snug line-clamp-2 flex-1"
          title={task.title}
        >
          {taskDisplayTitle(task)}
        </p>
        {!isConfirming && (
          <Button
            variant="icon"
            size="icon"
            onClick={handleRemoveClick}
            disabled={isBusy}
            aria-label={t('sprint.done.remove')}
            title={t('sprint.done.remove')}
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-md-error"
          >
            <MaterialIcon name="delete" size="sm" />
          </Button>
        )}
      </div>
      <IngestErrorNote task={task} />
      <SkillChips skills={task.skills ?? []} />
      {hasDeliverable && (
        <div className="flex flex-col gap-2">
          {task.deliverable_ref && (
            <span
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-md-outline-variant bg-md-surface-container-low px-2 py-1 font-mono text-[11px] text-pink"
              title={task.deliverable_ref}
            >
              <span aria-hidden>◈</span>
              <span className="truncate max-w-[13rem]">
                {task.deliverable_ref}
              </span>
            </span>
          )}
          {task.result_summary && (
            <p className="line-clamp-3 border-l-2 border-md-outline-variant pl-2 text-xs leading-relaxed text-low">
              {task.result_summary}
            </p>
          )}
          <DesignArtifactLinks task={task} />
          {handoff ? (
            <p className="flex items-center gap-1.5 text-xs text-low">
              <span className="text-success" aria-hidden>
                ✓
              </span>
              {t('sprint.designHandoff.sentTo', {
                name: handoff.worker_name,
              })}
            </p>
          ) : (
            <Button
              variant="primary"
              size="xs"
              className="self-start"
              disabled={isBusy}
              onClick={() => void DesignHandoffDialog.show({ task })}
            >
              {t('sprint.designHandoff.sendToAnalyst')}
            </Button>
          )}
        </div>
      )}
      {isConfirming && (
        <div className="flex flex-col gap-2 rounded-md border border-md-error/30 bg-md-error/5 px-3 py-2">
          <p className="text-body-sm text-md-on-surface">
            {t('sprint.done.removeConfirmMessage')}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCancelConfirm}
              disabled={isBusy}
            >
              {t('buttons.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={handleConfirm}
              disabled={isBusy}
            >
              {isBusy ? (
                <MaterialIcon
                  name="progress_activity"
                  size="xs"
                  className="animate-spin"
                />
              ) : (
                <MaterialIcon name="delete" size="xs" />
              )}
              {t('sprint.done.removeConfirm')}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
