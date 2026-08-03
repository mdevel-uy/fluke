import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Switch } from '@vibe/ui/components/Switch';
import { PageHeader, PageHeaderToggle } from '@vibe/ui/components/PageHeader';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import { useDashboardData } from '@/features/dashboard/model/useDashboardData';
import { useClaudeUsage } from '@/features/dashboard/model/useClaudeUsage';
import { cn } from '@/shared/lib/utils';
import { LiveChip } from './parts/LiveChip';
import { KpiStrip } from './KpiStrip';
import { WorkerGrid } from './WorkerGrid';
import { PipelinePanel } from './PipelinePanel';
import { ClaudeLimitsPanel } from './ClaudeLimitsPanel';
import { ImpactPanel } from './ImpactPanel';
import { ValueGeneratedPanel } from './ValueGeneratedPanel';
import { PullRequestsPanel } from './PullRequestsPanel';
import { AttentionPanel } from './AttentionPanel';
import { ActivityPanel } from './ActivityPanel';
import { DashboardSidebar, DASHBOARD_ANCHORS } from './DashboardSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';

export function DashboardPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('dashboard.title'));

  const data = useDashboardData();
  const claudeUsage = useClaudeUsage();
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const setAutoIngest = useAutoIngestStore((s) => s.setAutoIngest);

  // The panel cannot hide itself: it defines the second column of its row.
  const showLimits = claudeUsage !== null && claudeUsage.meters.length > 0;

  if (
    data.isWorkersLoading &&
    data.workers.length === 0 &&
    data.workspaces.length === 0
  ) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-primary">
        <Loader2
          className="h-5 w-5 animate-spin text-brand-on-surface"
          strokeWidth={1.75}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <PageHeader
        title={t('dashboard.title')}
        meta={
          <LiveChip isConnected={data.isConnected} stampKey={data.workspaces} />
        }
        actions={
          <PageHeaderToggle label={t('dashboard.autoIngest')}>
            <Switch
              checked={autoIngest}
              onCheckedChange={setAutoIngest}
              aria-label={t('dashboard.autoIngest')}
            />
          </PageHeaderToggle>
        }
      />

      <ShellSidebarPortal>
        <DashboardSidebar showLimits={showLimits} />
      </ShellSidebarPortal>
      <div className="flex-1 overflow-y-auto px-container-padding py-5">
        <div className="flex w-full flex-col gap-4">
          <div id={DASHBOARD_ANCHORS.overview}>
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
          </div>

          <div id={DASHBOARD_ANCHORS.workers}>
            <WorkerGrid
              workers={data.workers}
              workspaceById={data.workspaceById}
              activeTaskByWorkerId={data.activeTaskByWorkerId}
              doneTodayByWorker={data.doneTodayByWorker}
            />
          </div>

          <div
            id={DASHBOARD_ANCHORS.pipeline}
            className={cn(
              'grid grid-cols-1 items-stretch gap-4',
              showLimits && 'xl:grid-cols-[minmax(0,1fr)_minmax(300px,400px)]'
            )}
          >
            <PipelinePanel
              pipelineTotal={data.pipelineTotal}
              pipelineSegments={data.pipelineSegments}
              pipelineLabels={data.pipelineLabels}
            />
            {showLimits && <ClaudeLimitsPanel usage={claudeUsage} />}
          </div>

          <div id={DASHBOARD_ANCHORS.impact}>
            <ImpactPanel />
          </div>

          <div id={DASHBOARD_ANCHORS.valueGenerated}>
            <ValueGeneratedPanel />
          </div>

          <div
            id={DASHBOARD_ANCHORS.pullRequests}
            className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"
          >
            <PullRequestsPanel
              openPrs={data.openPrs}
              taskByWorkspaceId={data.taskByWorkspaceId}
            />
            <AttentionPanel attentionItems={data.attentionItems} />
          </div>

          <div id={DASHBOARD_ANCHORS.activity}>
            <ActivityPanel feedItems={data.feedItems} />
          </div>
        </div>
      </div>
    </div>
  );
}
