import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SectionTitle } from './parts/primitives';

export function AttentionPanel({
  attentionItems,
}: Pick<DashboardData, 'attentionItems'>) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle chip={attentionItems.length}>
        {t('dashboard.attentionSection')}
      </SectionTitle>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
        {attentionItems.length === 0 ? (
          <p className="p-4 text-sm text-low">
            {t('dashboard.attentionEmpty')}
          </p>
        ) : (
          attentionItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => appNavigation.goToWorkspace(item.workspaceId)}
              className="group flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left last:border-b-0 hover:bg-secondary"
            >
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                  item.tone === 'error'
                    ? 'bg-error/10 text-error'
                    : 'bg-warning/10 text-warning'
                )}
              >
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-high">
                  {item.title}
                </span>
                <span className="block truncate text-[11px] text-low">
                  {item.meta}
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-brand-on-surface group-hover:underline">
                {item.action}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
