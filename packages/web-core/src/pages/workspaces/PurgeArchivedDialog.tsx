import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { WarningIcon, GitBranchIcon } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { defineModal } from '@vibe/ui/lib/modals';

export interface PurgeArchivedDialogProps {
  count: number;
}

export type PurgeArchivedDialogResult = {
  action: 'confirmed' | 'canceled';
  deleteBranches?: boolean;
};

const PurgeArchivedDialogImpl = NiceModal.create<PurgeArchivedDialogProps>(
  ({ count }) => {
    const modal = useModal();
    const { t } = useTranslation();
    const [deleteBranches, setDeleteBranches] = useState(false);

    const handleConfirm = () => {
      modal.resolve({
        action: 'confirmed',
        deleteBranches,
      } as PurgeArchivedDialogResult);
      modal.hide();
    };

    const handleCancel = () => {
      modal.resolve({ action: 'canceled' } as PurgeArchivedDialogResult);
      modal.hide();
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleCancel}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <WarningIcon className="h-6 w-6 text-destructive" />
              <DialogTitle>{t('workspaces.purgeArchived.title')}</DialogTitle>
            </div>
            <DialogDescription className="text-left pt-2">
              {t('workspaces.purgeArchived.confirm', { count })}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div
              className="flex items-center gap-3 text-sm font-medium cursor-pointer select-none"
              onClick={() => setDeleteBranches((v) => !v)}
            >
              <Checkbox checked={deleteBranches} />
              <span className="flex items-center gap-2">
                <GitBranchIcon className="h-4 w-4" />
                {t('workspaces.purgeArchived.deleteBranchesLabel')}
              </span>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={handleCancel}>
              {t('buttons.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirm}>
              {t('workspaces.purgeArchived.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const PurgeArchivedDialog = defineModal<
  PurgeArchivedDialogProps,
  PurgeArchivedDialogResult
>(PurgeArchivedDialogImpl);
