import { useTranslation } from 'react-i18next';

export function IssuesEmptyState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 gap-3 text-center">
      <div className="flex flex-col gap-1 max-w-sm">
        <h2 className="text-title-sm font-semibold text-high leading-tight">
          {t('issues.emptyTitle')}
        </h2>
        <p className="text-sm text-normal leading-relaxed">
          {t('issues.emptyDescription')}
        </p>
      </div>
    </div>
  );
}
