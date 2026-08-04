import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { ClaudeUsage } from '@/features/dashboard/model/useClaudeUsage';
import { MeterBar, Panel, meterTone } from './parts/primitives';

/** "17:00" for a reset later today, "Tue 09:00" otherwise. */
function formatResetAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

const PCT_TONE_CLASS = {
  muted: 'text-normal',
  success: 'text-high',
  warning: 'text-warning',
  error: 'text-error',
} as const;

export function ClaudeLimitsPanel({ usage }: { usage: ClaudeUsage }) {
  const { t } = useTranslation('common');

  return (
    <Panel
      title={t('dashboard.claudeLimits.title')}
      chip={usage.plan ?? undefined}
      aside={
        usage.workers_on_claude > 0
          ? t('dashboard.claudeLimits.workersOnClaude', {
              count: usage.workers_on_claude,
            })
          : undefined
      }
    >
      <div className="flex flex-1 flex-col justify-center gap-2.5 p-3">
        {usage.meters.map((meter) => {
          const ratio = Math.min(1, Math.max(0, meter.used_percent / 100));
          const reset = formatResetAt(meter.resets_at);
          return (
            <div key={meter.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-xs text-normal">
                <span>
                  {t(`dashboard.claudeLimits.meter.${meter.key}`, {
                    defaultValue: meter.key,
                  })}
                </span>
                {reset && (
                  <span className="text-low">
                    · {t('dashboard.claudeLimits.resetsAt', { time: reset })}
                  </span>
                )}
                <span
                  className={cn(
                    'ml-auto font-semibold tabular-nums',
                    PCT_TONE_CLASS[meterTone(ratio)]
                  )}
                >
                  {Math.round(ratio * 100)}%
                </span>
              </div>
              <MeterBar ratio={ratio} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
