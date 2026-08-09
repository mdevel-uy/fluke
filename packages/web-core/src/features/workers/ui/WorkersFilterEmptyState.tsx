import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';

interface WorkersFilterEmptyStateProps {
  onClearFilters: () => void;
}

export function WorkersFilterEmptyState({
  onClearFilters,
}: WorkersFilterEmptyStateProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div
        aria-hidden
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-on-surface/10 text-brand-on-surface"
      >
        <Search className="h-7 w-7" strokeWidth={1.75} />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="font-sans text-title font-semibold text-high">
          {t('workers.filters.emptyTitle')}
        </h2>
        <p className="text-body-sm leading-relaxed text-low">
          {t('workers.filters.emptyDescription')}
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={onClearFilters}>
        {t('workers.filters.emptyAction')}
      </Button>
    </div>
  );
}
