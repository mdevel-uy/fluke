import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import { useDashboardData } from '@/features/dashboard/model/useDashboardData';
import { cn } from '@/shared/lib/utils';
import { LiveChip } from './parts/LiveChip';
import { KpiStrip } from './KpiStrip';
import { WorkerGrid } from './WorkerGrid';
import { PipelinePanel } from './PipelinePanel';
import { PullRequestsPanel } from './PullRequestsPanel';
import { AttentionPanel } from './AttentionPanel';
import { ActivityPanel } from './ActivityPanel';

export function DashboardPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('dashboard.title'));

  const data = useDashboardData();
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const setAutoIngest = useAutoIngestStore((s) => s.setAutoIngest);

  if (
    data.isWorkersLoading &&
    data.workers.length === 0 &&
    data.workspaces.length === 0
  ) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-md-background">
        <Loader2
          className="h-5 w-5 animate-spin text-brand-on-surface"
          strokeWidth={1.75}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-md-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-md-outline-variant bg-md-surface-bright px-container-padding">
        <h1 className="font-sans text-heading text-high">
          {t('dashboard.title')}
        </h1>
        <LiveChip isConnected={data.isConnected} stampKey={data.workspaces} />
        <span className="ml-auto flex items-center gap-2 text-xs text-normal">
          {t('dashboard.autoIngest')}
          <button
            type="button"
            role="switch"
            aria-checked={autoIngest}
            onClick={() => setAutoIngest(!autoIngest)}
            className={cn(
              'relative h-[18px] w-8 rounded-full transition-colors',
              autoIngest ? 'bg-brand' : 'bg-md-outline-variant'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
                autoIngest ? 'right-0.5' : 'left-0.5'
              )}
            />
          </button>
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-container-padding py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <KpiStrip
            stats={data.stats}
            pipeline={data.pipeline}
            reposInProgress={data.reposInProgress}
            nextQueuedTask={data.nextQueuedTask}
            openPrs={data.openPrs}
            oldestApprovalWait={data.oldestApprovalWait}
            doneToday={data.doneToday}
            failedToday={data.failedToday}
          />

          <WorkerGrid
            workers={data.workers}
            workspaceById={data.workspaceById}
            activeTaskByWorkerId={data.activeTaskByWorkerId}
            doneTodayByWorker={data.doneTodayByWorker}
          />

          <PipelinePanel
            pipelineTotal={data.pipelineTotal}
            pipelineSegments={data.pipelineSegments}
            pipelineLabels={data.pipelineLabels}
          />

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <PullRequestsPanel
              openPrs={data.openPrs}
              taskByWorkspaceId={data.taskByWorkspaceId}
            />
            <AttentionPanel attentionItems={data.attentionItems} />
          </div>

          <ActivityPanel feedItems={data.feedItems} />
        </div>
      </div>
    </div>
  );
}
