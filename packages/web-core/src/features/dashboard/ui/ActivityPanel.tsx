import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { FEED_DOT_CLASS } from '@/features/dashboard/model/dashboardMetrics';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SectionTitle } from './parts/primitives';

export function ActivityPanel({ feedItems }: Pick<DashboardData, 'feedItems'>) {
  const { t } = useTranslation('common');
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{t('dashboard.activitySection')}</SectionTitle>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
        {feedItems.length === 0 ? (
          <p className="p-4 text-sm text-low">{t('dashboard.activityEmpty')}</p>
        ) : (
          feedItems.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm last:border-b-0"
            >
              <span className="w-11 shrink-0 text-[11px] text-low tabular-nums">
                {item.time.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  FEED_DOT_CLASS[item.tone]
                )}
              />
              <span className="min-w-0 flex-1 truncate text-normal">
                {item.text}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
