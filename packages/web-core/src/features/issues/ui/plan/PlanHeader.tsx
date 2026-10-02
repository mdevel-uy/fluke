import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useConcurrencyStatus } from '@/shared/hooks/useConcurrencyStatus';

/**
 * Header pieces of the Issues page in the fluke v2 mockup
 * (design/mockups/fluke-v2/issues-plan.html, `header`): the Lista / Grupos /
 * Plan tabs next to the title, and the Plan controls on the right.
 *
 * "Pausar al terminar cada wave", "Colapsar todas" and "Ejecutar todas" are
 * drawn as in the mockup but disabled: they come with #664 and #666.
 */

export type IssuesView = 'list' | 'groups' | 'plan';

export function IssuesViewTabs({
  view,
  onChange,
}: {
  view: IssuesView;
  onChange: (view: IssuesView) => void;
}) {
  const { t } = useTranslation('common');
  const views: IssuesView[] = ['list', 'groups', 'plan'];
  return (
    <div
      role="tablist"
      aria-label={t('issues.plan.tabsLabel')}
      className="flex overflow-hidden rounded-md border border-md-outline-variant"
    >
      {views.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => onChange(v)}
          className={cn(
            'px-3.5 py-1.5 text-[13px] text-normal hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-md-primary',
            view === v &&
              'bg-md-surface-container text-high shadow-[inset_0_-2px_0_hsl(var(--md-primary))]'
          )}
        >
          {t(`issues.plan.tabs.${v}`)}
        </button>
      ))}
    </div>
  );
}

export function PlanHeaderActions() {
  const { t } = useTranslation('common');
  const { data: concurrency } = useConcurrencyStatus();
  const limit = concurrency?.limit ?? 0;
  const used = concurrency?.used ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3.5">
      {limit > 0 && (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-normal">
          {t('issues.plan.slots', { used, limit })}
          {Array.from({ length: limit }, (_, k) => (
            <i
              key={k}
              className={cn(
                'size-2.5 rounded-[3px] border border-md-outline-variant',
                k < used && 'border-md-primary bg-md-primary'
              )}
            />
          ))}
        </span>
      )}
      <label
        className="inline-flex cursor-default items-center gap-2 text-[13px] text-normal"
        title={t('issues.plan.comingSoon')}
      >
        <input type="checkbox" disabled />
        {t('issues.plan.pauseBetweenWaves')}
      </label>
      <button
        type="button"
        disabled
        title={t('issues.plan.comingSoon')}
        className="inline-flex h-8 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-3 text-[13px] text-high disabled:cursor-default"
      >
        {t('issues.plan.collapseAll')}
      </button>
      <button
        type="button"
        disabled
        title={t('issues.plan.comingSoon')}
        className="inline-flex h-8 items-center rounded-md border border-md-primary bg-md-primary px-3 text-[13px] font-medium text-md-on-primary disabled:cursor-default"
      >
        {t('issues.plan.runAll')}
      </button>
    </div>
  );
}
