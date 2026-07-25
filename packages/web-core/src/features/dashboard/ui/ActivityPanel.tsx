import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { FEED_DOT_CLASS } from '@/features/dashboard/model/dashboardMetrics';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { Panel, PanelEmpty } from './parts/primitives';

export function ActivityPanel({ feedItems }: Pick<DashboardData, 'feedItems'>) {
  const { t } = useTranslation('common');
  return (
    <Panel title={t('dashboard.activitySection')}>
      {feedItems.length === 0 ? (
        <PanelEmpty>{t('dashboard.activityEmpty')}</PanelEmpty>
      ) : (
        feedItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
          >
            <span className="w-11 shrink-0 text-xs text-low tabular-nums">
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
    </Panel>
  );
}
