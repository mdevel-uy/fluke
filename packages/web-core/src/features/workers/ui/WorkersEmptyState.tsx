import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';

interface WorkersEmptyStateProps {
  onCreateWorker?: () => void;
}

export function WorkersEmptyState({ onCreateWorker }: WorkersEmptyStateProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 gap-4 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-md-secondary-container text-md-on-secondary-container"
        aria-hidden
      >
        <MaterialIcon name="group" size="lg" />
      </div>
      <div className="flex flex-col gap-1.5 max-w-sm">
        <h2 className="text-title-sm font-hanken font-semibold text-md-on-surface leading-tight">
          {t('workers.emptyTitle')}
        </h2>
        <p className="text-body-sm text-md-on-surface-variant leading-relaxed">
          {t('workers.emptyDescription')}
        </p>
      </div>
      {onCreateWorker && (
        <Button
          variant="primary"
          size="sm"
          onClick={onCreateWorker}
          className="mt-1 active:scale-95 transition-all duration-200"
        >
          <MaterialIcon name="add" size="xs" />
          {t('workers.newWorker')}
        </Button>
      )}
    </div>
  );
}
