import { useTranslation } from 'react-i18next';
import { FileText, Loader2 } from 'lucide-react';
import { Switch } from '@vibe/ui/components/Switch';
import { Button } from '@vibe/ui/components/Button';
import { PageHeader, PageHeaderToggle } from '@vibe/ui/components/PageHeader';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAutoIngestStore } from '@/features/sprint/model/useAutoIngestStore';
import { useDashboardData } from '@/features/dashboard/model/useDashboardData';
import { DEFAULT_HOURS_PER_TASK } from '@/features/dashboard/model/valueDefaults';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { LiveChip } from './parts/LiveChip';
import { KpiStrip } from './KpiStrip';
import { AttentionPanel, useAttentionItems } from './AttentionPanel';
import { MergeGatePanel } from './MergeGatePanel';
import { ReposPanel } from './ReposPanel';
import { RunningPanel } from './RunningPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { ImpactPanel } from './ImpactPanel';
import { ValueActivityPanel } from './ValueActivityPanel';

/**
 * From what needs a person to what already happened: attention, repos, what
 * runs now, subscriptions, impact and cost, value and activity.
 */
export function DashboardPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('dashboard.title'));

  const data = useDashboardData();
  const attention = useAttentionItems(data);
  const { config } = useUserSystem();
  const autoIngest = useAutoIngestStore((s) => s.autoIngest);
  const setAutoIngest = useAutoIngestStore((s) => s.setAutoIngest);
  const appNavigation = useAppNavigation();
  const hoursPerTicket =
    config?.default_hours_saved_per_task ?? DEFAULT_HOURS_PER_TASK;

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <PageHeader
        title={t('dashboard.title')}
        meta={
          <LiveChip isConnected={data.isConnected} stampKey={data.overview} />
        }
        actions={
          <>
            <PageHeaderToggle label={t('dashboard.autoIngest')}>
              <Switch
                checked={autoIngest}
                onCheckedChange={setAutoIngest}
                aria-label={t('dashboard.autoIngest')}
              />
            </PageHeaderToggle>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => appNavigation.goToPilotReport()}
            >
              <FileText size={16} strokeWidth={1.75} />
              {t('dashboard.openPilotReport')}
            </Button>
          </>
        }
      />

      {data.overview === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2
            className="h-5 w-5 animate-spin text-brand-on-surface"
            strokeWidth={1.75}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-container-padding py-5">
          <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-4">
            <KpiStrip
              data={data}
              attentionCount={attention.items.length}
              attentionSummary={attention.summary}
              hoursPerTicket={hoursPerTicket}
            />
            <AttentionPanel items={attention.items} />
            <MergeGatePanel tickets={data.tickets} />
            <ReposPanel repos={data.overview.repos} />
            <RunningPanel
              overview={data.overview}
              workspaceById={data.workspaceById}
            />
            {data.providers && <ProvidersPanel usage={data.providers} />}
            <ImpactPanel tickets={data.tickets} />
            <ValueActivityPanel
              tickets={data.tickets}
              events={data.feedEvents}
            />
          </div>
        </div>
      )}
    </div>
  );
}
