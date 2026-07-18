import { useTranslation } from 'react-i18next';
import { UsersIcon } from '@phosphor-icons/react';

export function WorkersEmptyState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-half text-low">
      <UsersIcon className="size-icon-lg" weight="regular" />
      <p className="text-sm font-medium text-normal">
        {t('workers.emptyTitle')}
      </p>
      <p className="text-sm text-low">{t('workers.emptyDescription')}</p>
    </div>
  );
}
