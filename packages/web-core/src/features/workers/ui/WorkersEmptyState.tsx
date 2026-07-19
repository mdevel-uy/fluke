import { useTranslation } from 'react-i18next';
import { UsersIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';

interface WorkersEmptyStateProps {
  onCreateWorker?: () => void;
}

export function WorkersEmptyState({ onCreateWorker }: WorkersEmptyStateProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-double py-double text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-border text-low">
        <UsersIcon className="size-icon-xl" weight="regular" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-high">
          {t('workers.emptyTitle')}
        </p>
        <p className="text-sm text-low max-w-xs">
          {t('workers.emptyDescription')}
        </p>
      </div>
      {onCreateWorker && (
        <Button
          variant="default"
          size="sm"
          onClick={onCreateWorker}
          className="mt-1"
        >
          <PlusIcon className="mr-1 size-icon-sm" weight="bold" />
          {t('workers.newWorker')}
        </Button>
      )}
    </div>
  );
}
