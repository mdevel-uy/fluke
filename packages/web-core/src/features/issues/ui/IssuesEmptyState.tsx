import { useTranslation } from 'react-i18next';
import { WarningCircleIcon } from '@phosphor-icons/react';

export function IssuesEmptyState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-half text-low">
      <WarningCircleIcon className="size-icon-lg" weight="regular" />
      <p className="text-sm font-medium text-normal">
        {t('issues.emptyTitle')}
      </p>
      <p className="text-sm text-low">{t('issues.emptyDescription')}</p>
    </div>
  );
}
