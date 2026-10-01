import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { create, useModal } from '@ebay/nice-modal-react';
import type { BaseCodingAgent } from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import { cn } from '@/shared/lib/utils';

export interface DisconnectProviderDialogProps {
  name: string;
  /** Workers that pinned a model of this provider. */
  workers: number;
  isDefault: boolean;
  /** Other connected providers that can take over as default. */
  replacements: { agent: BaseCodingAgent; label: string }[];
}

export type DisconnectProviderResult =
  | { action: 'confirmed'; replacement: BaseCodingAgent | null }
  | { action: 'canceled' };

const DisconnectProviderDialogImpl = create<DisconnectProviderDialogProps>(
  ({ name, workers, isDefault, replacements }) => {
    const { t } = useTranslation(['settings', 'common']);
    const modal = useModal();
    const [replacement, setReplacement] = useState<BaseCodingAgent | null>(
      isDefault ? (replacements[0]?.agent ?? null) : null
    );

    const close = (result: DisconnectProviderResult) => {
      modal.resolve(result);
      modal.hide();
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && close({ action: 'canceled' })}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('settings.providers.disconnect.title', { name })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-normal">
            <p>
              {t('settings.providers.disconnect.body')}{' '}
              {workers > 0 &&
                t('settings.providers.disconnect.workers', {
                  count: workers,
                  name,
                })}
            </p>
            {isDefault && replacements.length > 0 && (
              <div className="space-y-2" role="radiogroup">
                <p className="font-medium text-high">
                  {t('settings.providers.disconnect.pickReplacement', {
                    name,
                  })}
                </p>
                {replacements.map((option) => (
                  <label
                    key={option.agent}
                    className={cn(
                      'flex items-center gap-2 rounded-sm border px-3 py-2 cursor-pointer',
                      replacement === option.agent
                        ? 'border-brand bg-brand/10'
                        : 'border-border'
                    )}
                  >
                    <input
                      type="radio"
                      name="replacement"
                      checked={replacement === option.agent}
                      onChange={() => setReplacement(option.agent)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            )}
            {isDefault && replacements.length === 0 && (
              <p className="font-medium text-high">
                {t('settings.providers.disconnect.noReplacement', { name })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => close({ action: 'canceled' })}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => close({ action: 'confirmed', replacement })}
            >
              {t('settings.providers.disconnect.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const DisconnectProviderDialog = defineModal<
  DisconnectProviderDialogProps,
  DisconnectProviderResult
>(DisconnectProviderDialogImpl);
