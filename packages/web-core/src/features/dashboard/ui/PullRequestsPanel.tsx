import { useTranslation } from 'react-i18next';
import { GitPullRequest } from 'lucide-react';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SectionTitle, StatusPill } from './parts/primitives';

export function PullRequestsPanel({
  openPrs,
  taskByWorkspaceId,
}: Pick<DashboardData, 'openPrs' | 'taskByWorkspaceId'>) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle chip={t('dashboard.openCount', { count: openPrs.length })}>
        {t('dashboard.prsSection')}
      </SectionTitle>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-md-surface-container-lowest shadow-soft">
        {openPrs.length === 0 ? (
          <p className="p-4 text-sm text-low">{t('dashboard.prsEmpty')}</p>
        ) : (
          openPrs.map((ws) => {
            const task = taskByWorkspaceId.get(ws.id);
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => appNavigation.goToWorkspace(ws.id)}
                className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-2.5 text-left last:border-b-0 hover:bg-secondary"
              >
                <GitPullRequest
                  className="h-4 w-4 shrink-0 text-low"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-high">
                    <span className="tabular-nums">#{ws.prNumber}</span> ·{' '}
                    {ws.taskTitle || ws.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-3 text-[11px] text-low">
                    <span className="truncate font-mono">{ws.branch}</span>
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
      </div>
    </section>
  );
}
