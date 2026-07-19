import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';

export function IssuesEmptyState() {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 gap-4 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/10 text-brand"
        aria-hidden
      >
        <AlertCircle className="h-7 w-7" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1.5 max-w-sm">
        <h2 className="text-lg font-semibold text-high leading-tight">
          {t('issues.emptyTitle')}
        </h2>
        <p className="text-sm text-low leading-relaxed">
          {t('issues.emptyDescription')}
        </p>
      </div>
    </div>
  );
}
