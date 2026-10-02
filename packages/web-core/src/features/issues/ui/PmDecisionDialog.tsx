import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Alert } from '@vibe/ui/components/Alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Textarea } from '@vibe/ui/components/Textarea';
import { defineModal } from '@/shared/lib/modals';
import { useRemoveIssueLabel } from '@/features/issues/model/useRepoIssues';
import { usePublishPmDecision } from '@/features/issues/model/usePublishPmDecision';
import type { RepoIssue } from '@/features/issues/types';

export const PM_DECISION_LABEL = 'pm:decision';

export const hasPmDecisionPending = (issue: RepoIssue) =>
  issue.labels.some((l) => l.name === PM_DECISION_LABEL);

export interface PmDecisionDialogProps {
  issue: RepoIssue;
  repoId: string;
}

export type PmDecisionResult = 'published' | 'canceled';

/**
 * Publish the PM's decision as a GitHub comment, then drop the
 * `pm:decision` label (comment-first and retry rules live in
 * usePublishPmDecision).
 */
const PmDecisionDialogImpl = create<PmDecisionDialogProps>(
  ({ issue, repoId }) => {
    const modal = useModal();
    const { t } = useTranslation('common');
    const removeLabel = useRemoveIssueLabel(repoId);

    const [text, setText] = useState('');
    const {
      run,
      submitting,
      error: publishError,
      commentPublished,
    } = usePublishPmDecision(repoId, issue.number);
    const error = !publishError
      ? null
      : publishError.step === 'comment'
        ? publishError.message
        : t('issues.pmDecision.labelRemovalFailed', {
            error: publishError.message,
          });

    const closeWith = (result: PmDecisionResult) => {
      modal.resolve(result);
      modal.hide();
      modal.remove();
    };

    const handleConfirm = async () => {
      const body = text.trim();
      if (!body && !commentPublished) return;
      const ok = await run(body, () =>
        removeLabel.mutateAsync({
          issueNumber: issue.number,
          labelName: PM_DECISION_LABEL,
        })
      );
      if (ok) closeWith('published');
    };

    const handleOpenChange = (open: boolean) => {
      if (open) return;
      closeWith(commentPublished ? 'published' : 'canceled');
    };

    const canConfirm = !submitting && (commentPublished || !!text.trim());

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {t('issues.pmDecision.title', { number: issue.number })}
            </DialogTitle>
            <DialogDescription>
              {t('issues.pmDecision.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('issues.pmDecision.placeholder')}
              rows={6}
              className="resize-y"
              disabled={submitting || commentPublished}
              autoFocus
            />
            {error && <Alert variant="destructive">{error}</Alert>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('buttons.cancel')}
            </Button>
            <Button onClick={() => void handleConfirm()} disabled={!canConfirm}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {commentPublished
                ? t('issues.pmDecision.retryLabelRemoval')
                : t('issues.pmDecision.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const PmDecisionDialog = defineModal<
  PmDecisionDialogProps,
  PmDecisionResult
>(PmDecisionDialogImpl);
