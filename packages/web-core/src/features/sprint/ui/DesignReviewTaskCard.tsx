import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from './IssueBadge';
import { SkillChips } from './SkillChips';
import { DesignArtifactLinks } from './DesignArtifactLinks';

interface DesignReviewTaskCardProps {
  task: WorkerTask;
  isBusy: boolean;
  /** Marks the task done — the user's explicit OK on the artifact. */
  onApprove: () => void;
  /** Cancels the task and tears down its workspace. */
  onUnassign: () => void;
}

/**
 * In-review card for designer tasks: the deliverable exists but the user has
 * not approved it yet. Unlike developer in-review (PR-driven), the exit from
 * this state is always manual — view the artifact in the still-alive
 * workspace, request follow-ups there if needed, then approve here.
 */
export function DesignReviewTaskCard({
  task,
  isBusy,
  onApprove,
  onUnassign,
}: DesignReviewTaskCardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const [confirming, setConfirming] = useState<'approve' | 'unassign' | null>(
    null
  );

  const handleOpen = () => {
    if (task.workspace_id) {
      appNavigation.goToWorkspace(task.workspace_id);
    }
  };

  const handleConfirm = () => {
    const action = confirming;
    setConfirming(null);
    if (action === 'approve') onApprove();
    if (action === 'unassign') onUnassign();
  };

  return (
    <article className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-outline-variant rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:-translate-y-px">
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-2 w-2 rounded-full bg-md-primary animate-pulse shrink-0"
          aria-hidden
        />
        {task.issue_number != null && (
          <IssueBadge issueNumber={task.issue_number} className="mt-px" />
        )}
        <p
          className="text-body-sm font-sans text-md-on-surface font-medium leading-snug line-clamp-2"
          title={task.title}
        >
          {taskDisplayTitle(task)}
        </p>
      </div>
      <SkillChips skills={task.skills ?? []} />
      <span className="inline-flex items-center gap-1 self-start rounded-full px-2 py-0.5 text-label-caps font-geist font-semibold uppercase tracking-widest bg-warning/10 text-warning border border-warning/20">
        <MaterialIcon name="visibility" size="xs" />
        {t('sprint.designReview.awaitingApproval')}
      </span>
      {task.deliverable_ref && (
        <span
          className="inline-flex items-center gap-1.5 self-start rounded-md border border-md-outline-variant bg-md-surface-container-low px-2 py-1 font-mono text-[11px] text-pink"
          title={task.deliverable_ref}
        >
          <span aria-hidden>◈</span>
          <span className="truncate max-w-[13rem]">{task.deliverable_ref}</span>
        </span>
      )}
      {task.result_summary && (
        <p className="line-clamp-3 border-l-2 border-md-outline-variant pl-2 text-xs leading-relaxed text-low">
          {task.result_summary}
        </p>
      )}
      <DesignArtifactLinks task={task} />
      {confirming ? (
        <div
          className={
            confirming === 'unassign'
              ? 'flex flex-col gap-2 rounded-md border border-md-error/30 bg-md-error/5 px-3 py-2'
              : 'flex flex-col gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2'
          }
        >
          <p className="text-body-sm text-md-on-surface">
            {confirming === 'unassign'
              ? t('sprint.inReview.unassignConfirmMessage')
              : t('sprint.designReview.approveConfirmMessage')}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setConfirming(null)}
              disabled={isBusy}
            >
              {t('buttons.cancel')}
            </Button>
            <Button
              variant={confirming === 'unassign' ? 'destructive' : 'primary'}
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
                <MaterialIcon
                  name={confirming === 'unassign' ? 'person_remove' : 'check'}
                  size="xs"
                />
              )}
              {confirming === 'unassign'
                ? t('sprint.inReview.unassignConfirm')
                : t('sprint.designReview.approveConfirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1 flex-wrap">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setConfirming('unassign')}
            disabled={isBusy}
            title={t('sprint.inReview.unassign')}
            aria-label={t('sprint.inReview.unassign')}
            className="text-md-on-surface-variant hover:text-md-error hover:bg-md-error/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MaterialIcon name="person_remove" size="xs" />
          </Button>
          {task.workspace_id && (
            <Button
              variant="tonal"
              size="xs"
              onClick={handleOpen}
              title={t('sprint.designReview.viewDesign')}
              className="active:scale-95 transition-all duration-200"
            >
              <MaterialIcon name="open_in_new" size="xs" />
              {t('sprint.designReview.viewDesign')}
            </Button>
          )}
          <Button
            variant="primary"
            size="xs"
            onClick={() => setConfirming('approve')}
            disabled={isBusy}
          >
            <MaterialIcon name="check" size="xs" />
            {t('sprint.designReview.approve')}
          </Button>
        </div>
      )}
    </article>
  );
}
