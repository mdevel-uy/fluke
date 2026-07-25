import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import { SectionTitle } from './parts/primitives';

export function PipelinePanel({
  pipelineTotal,
  pipelineSegments,
  pipelineLabels,
}: Pick<
  DashboardData,
  'pipelineTotal' | 'pipelineSegments' | 'pipelineLabels'
>) {
  const { t } = useTranslation('common');
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle chip={t('dashboard.pipelineHint')}>
        {t('dashboard.pipelineSection')}
      </SectionTitle>
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-md-surface-container-lowest p-3.5 shadow-soft">
        {pipelineTotal > 0 && (
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
            {pipelineSegments
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
        )}
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
    </section>
  );
}
