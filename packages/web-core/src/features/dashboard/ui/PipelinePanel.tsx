import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { Panel } from './parts/primitives';

export function PipelinePanel({
  pipelineTotal,
  pipelineSegments,
  pipelineLabels,
}: Pick<
  DashboardData,
  'pipelineTotal' | 'pipelineSegments' | 'pipelineLabels'
>) {
  const { t } = useTranslation('common');
  const barLabel = pipelineSegments
    .map((segment) => `${segment.count} ${pipelineLabels[segment.key]}`)
    .join(', ');

  return (
    <Panel
      title={t('dashboard.pipelineSection')}
      aside={t('dashboard.pipelineHint')}
    >
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div
          className="flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-md-outline-variant/60"
          role="img"
          aria-label={barLabel}
        >
          {pipelineTotal > 0 &&
            pipelineSegments
              .filter((segment) => segment.count > 0)
              .map((segment) => (
                <div
                  key={segment.key}
                  className={segment.color}
                  style={{
                    width: `${(segment.count / pipelineTotal) * 100}%`,
                  }}
                />
              ))}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-normal">
          {pipelineSegments.map((segment) => (
            <span key={segment.key} className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-sm', segment.color)} />
              {pipelineLabels[segment.key]}{' '}
              <span className="font-semibold text-high tabular-nums">
                {segment.count}
              </span>
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}
