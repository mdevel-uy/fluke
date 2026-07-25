import { useTranslation } from 'react-i18next';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { Panel, PanelEmpty, StatusPill } from './parts/primitives';

export function PullRequestsPanel({
  openPrs,
  taskByWorkspaceId,
}: Pick<DashboardData, 'openPrs' | 'taskByWorkspaceId'>) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  return (
    <Panel
      title={t('dashboard.prsSection')}
      chip={t('dashboard.openCount', { count: openPrs.length })}
    >
      {openPrs.length === 0 ? (
        <PanelEmpty>{t('dashboard.prsEmpty')}</PanelEmpty>
      ) : (
        openPrs.map((ws) => {
          const task = taskByWorkspaceId.get(ws.id);
          return (
            <button
              key={ws.id}
              type="button"
              onClick={() => appNavigation.goToWorkspace(ws.id)}
              className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-high">
                  <span className="tabular-nums">#{ws.prNumber}</span> ·{' '}
                  {ws.taskTitle || ws.name}
                </span>
                <span className="mt-px flex items-center gap-2 text-xs text-low">
                  <span className="truncate font-mono text-code">
                    {ws.branch}
                  </span>
                  {(ws.linesAdded !== undefined ||
                    ws.linesRemoved !== undefined) && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-success">
                        +{ws.linesAdded ?? 0}
                      </span>{' '}
                      <span className="text-error">
                        −{ws.linesRemoved ?? 0}
                      </span>
                    </span>
                  )}
                </span>
              </span>
              {ws.prMergeable === 'conflicting' ? (
                <StatusPill tone="error" label={t('dashboard.conflicting')} />
              ) : ws.prMergeable === 'mergeable' ? (
                <StatusPill tone="success" label={t('dashboard.mergeable')} />
              ) : task?.status === 'in_review' ? (
                <StatusPill tone="info" label={t('dashboard.inReview')} />
              ) : (
                <StatusPill tone="muted" label={t('dashboard.openPill')} />
              )}
            </button>
          );
        })
      )}
    </Panel>
  );
}
