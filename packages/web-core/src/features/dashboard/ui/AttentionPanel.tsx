import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { Panel, PanelEmpty } from './parts/primitives';

export function AttentionPanel({
  attentionItems,
}: Pick<DashboardData, 'attentionItems'>) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  return (
    <Panel title={t('dashboard.attentionSection')} chip={attentionItems.length}>
      {attentionItems.length === 0 ? (
        <PanelEmpty>{t('dashboard.attentionEmpty')}</PanelEmpty>
      ) : (
        attentionItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => appNavigation.goToWorkspace(item.workspaceId)}
            className="group flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded',
                item.tone === 'error'
                  ? 'bg-error/10 text-error'
                  : 'bg-warning/10 text-warning'
              )}
            >
              <item.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-high">
                {item.title}
              </span>
              <span className="block truncate text-xs text-low">
                {item.meta}
              </span>
            </span>
            <span className="shrink-0 text-xs font-medium text-brand-on-surface group-hover:underline">
              {item.action}
            </span>
          </button>
        ))
      )}
    </Panel>
  );
}
