import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { GitMerge } from 'lucide-react';
import type { Config } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal } from '@/shared/lib/modals';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import type { MergeGateState } from '@/features/issues/lib/mergeGate';
import { CiFactText } from './MergeFacts';

// The merge settings of Config v10 (#797) are not in `shared/types.ts` yet:
// remove once they are generated.
type ConfigWithMerge = Config & {
  pr_merge_method?: 'merge' | 'squash' | 'rebase';
  pr_delete_branch_after_merge?: boolean;
};

export interface MergePrConfirmDialogProps {
  prNumber: number;
  prUrl?: string | null;
  title?: string;
  gate: MergeGateState;
}

/**
 * Confirmation before merging (irreversible, goes out to GitHub). Shows what
 * the merge will do as configured in Settings; focus starts on Cancel so an
 * impulsive Enter does not merge. Resolves `true` to merge.
 */
const MergePrConfirmImpl = create<MergePrConfirmDialogProps>(
  ({ prNumber, prUrl, title, gate }) => {
    const { t } = useTranslation('common');
    const modal = useModal();
    const { config } = useUserSystem();
    const merge = config as ConfigWithMerge | null;
    const method = merge?.pr_merge_method ?? 'merge';
    const deleteBranch = merge?.pr_delete_branch_after_merge ?? true;

    const close = (confirmed: boolean) => {
      modal.resolve(confirmed);
      modal.hide();
    };

    const methodLabel =
      method === 'squash'
        ? t('mergePr.method.squash')
        : method === 'rebase'
          ? t('mergePr.method.rebase')
          : t('mergePr.method.merge');
    const warning =
      gate.notice === 'ciPending'
        ? t('mergePr.confirm.warnPending')
        : gate.notice === 'ciUnavailable'
          ? t('mergePr.confirm.warnUnavailable')
          : null;

    return (
      <Dialog open={modal.visible} onOpenChange={() => close(false)}>
        <DialogContent
          role="alertdialog"
          aria-describedby="merge-pr-irreversible"
          className="sm:max-w-[460px]"
        >
          <DialogHeader>
            <DialogTitle>
              {t('mergePr.confirm.title', { number: prNumber })}
            </DialogTitle>
            {title && (
              <DialogDescription className="text-left">
                {title}
              </DialogDescription>
            )}
          </DialogHeader>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-low">{t('mergePr.confirm.pr')}</dt>
            <dd className="m-0 text-high">
              {t('mergePr.prNumber', { number: prNumber })}
              {prUrl && (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-xs text-brand-on-surface hover:underline"
                >
                  {t('mergePr.openOnGithub')}
                </a>
              )}
            </dd>
            <dt className="text-low">{t('mergePr.confirm.method')}</dt>
            <dd className="m-0 text-high">
              {methodLabel}
              <button
                type="button"
                onClick={() => {
                  close(false);
                  void SettingsDialog.show({ initialSection: 'general' });
                }}
                className="ml-2 text-xs text-brand-on-surface hover:underline"
              >
                {t('mergePr.confirm.changeInSettings')}
              </button>
            </dd>
            <dt className="text-low">{t('mergePr.confirm.branch')}</dt>
            <dd className="m-0 text-high">
              {deleteBranch
                ? t('mergePr.confirm.branchDeleted')
                : t('mergePr.confirm.branchKept')}
            </dd>
            <dt className="text-low">{t('mergePr.confirm.ci')}</dt>
            <dd className="m-0 text-high">
              <CiFactText ci={gate.ci} />
            </dd>
          </dl>
          {warning && (
            <div className="rounded bg-warning/10 px-2 py-1.5 text-xs leading-[1.4] text-high">
              {warning}
            </div>
          )}
          <p id="merge-pr-irreversible" className="m-0 text-xs text-normal">
            {t('mergePr.confirm.irreversible')}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              className="h-10 sm:h-[26px]"
              onClick={() => close(false)}
            >
              {t('mergePr.confirm.cancel')}
            </Button>
            <Button className="h-10 sm:h-[26px]" onClick={() => close(true)}>
              <GitMerge className="size-3.5" aria-hidden />
              {t('mergePr.confirm.submit', { number: prNumber })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const MergePrConfirmDialog = defineModal<
  MergePrConfirmDialogProps,
  boolean
>(MergePrConfirmImpl);
