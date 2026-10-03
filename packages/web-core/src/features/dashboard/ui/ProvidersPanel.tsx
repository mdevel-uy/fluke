import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ProviderUsage,
  ProvidersUsageResponse,
  UsageMeter,
} from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  agentLabel,
  formatResetAt,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import { MeterBar, Panel, meterTone } from './parts/primitives';

type Mode = 'all' | 'one';
const MODE_KEY = 'fluke-dashboard-providers-mode';

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'one' ? 'one' : 'all';
  } catch {
    return 'all';
  }
}

const PCT_CLASS = {
  muted: 'text-normal',
  success: 'text-normal',
  warning: 'text-warning',
  error: 'text-error',
} as const;

const DOT_CLASS: Record<string, string> = {
  CLAUDE_CODE: 'bg-[#d97757]',
  COPILOT: 'bg-brand',
  GEMINI: 'bg-info',
};

function Meter({ meter, large }: { meter: UsageMeter; large?: boolean }) {
  const { t } = useTranslation('common');
  const ratio = Math.min(1, Math.max(0, meter.used_percent / 100));
  const reset = formatResetAt(meter.resets_at);
  const counted =
    meter.used !== null && meter.limit !== null
      ? t('dashboard.providers.counted', {
          used: Math.round(meter.used),
          limit: Math.round(meter.limit),
        })
      : null;
  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'flex items-baseline justify-between gap-2 text-normal',
          large ? 'text-sm' : 'text-xs'
        )}
      >
        <span>
          {t(`dashboard.providers.meter.${meter.key}`, {
            defaultValue: meter.key,
          })}
        </span>
        <span
          className={cn('font-mono tabular-nums', PCT_CLASS[meterTone(ratio)])}
        >
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <MeterBar ratio={ratio} />
      {(counted || reset) && (
        <span className="text-[11px] text-low">
          {[counted, reset && t('dashboard.providers.resets', { time: reset })]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
    </div>
  );
}

function Heading({
  provider,
  large,
}: {
  provider: ProviderUsage;
  large?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 self-center rounded-full',
          DOT_CLASS[provider.agent] ?? 'bg-md-outline'
        )}
      />
      <b
        className={cn('font-semibold text-high', large ? 'text-lg' : 'text-sm')}
      >
        {agentLabel(provider.agent)}
      </b>
      {provider.plan && (
        <span className="rounded-full border border-border px-2 py-px text-xs text-low">
          {provider.plan}
        </span>
      )}
    </div>
  );
}

function NoMeters() {
  const { t } = useTranslation('common');
  return (
    <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-low">
      {t('dashboard.providers.noMeters')}
    </p>
  );
}

function RunningText({ count }: { count: number }) {
  const { t } = useTranslation('common');
  return count > 0
    ? t('dashboard.providers.running', { count })
    : t('dashboard.providers.idle');
}

function ProviderCard({ provider }: { provider: ProviderUsage }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-secondary/40 p-3">
      <Heading provider={provider} />
      {provider.meters.length === 0 ? (
        <NoMeters />
      ) : (
        provider.meters.map((m) => <Meter key={m.key} meter={m} />)
      )}
      <span className="text-xs text-low">
        <RunningText count={Number(provider.running)} />
      </span>
    </div>
  );
}

function ProviderDetail({ provider }: { provider: ProviderUsage }) {
  const { t } = useTranslation('common');
  const { data: workers = [] } = useWorkers();
  const { config } = useUserSystem();
  const defaultAgent = config?.executor_profile.executor;
  const profiles = workers
    .filter(
      (w) => !w.archived && (w.executor ?? defaultAgent) === provider.agent
    )
    .map((w) => (w.model ? `${w.name} (${w.model})` : w.name));

  return (
    <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <Heading provider={provider} large />
        {provider.meters.length === 0 ? (
          <NoMeters />
        ) : (
          provider.meters.map((m) => <Meter key={m.key} meter={m} large />)
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-xs text-low">
          {t('dashboard.providers.profiles')}
        </dt>
        <dd className="text-normal">
          {profiles.length > 0
            ? profiles.join(', ')
            : t('dashboard.providers.noProfiles')}
        </dd>
        <dt className="text-xs text-low">{t('dashboard.providers.now')}</dt>
        <dd className="text-normal">
          <RunningText count={Number(provider.running)} />
        </dd>
        <dt className="text-xs text-low">{t('dashboard.providers.cost30')}</dt>
        <dd className="font-mono text-warning">
          {usdFormatter.format(provider.cost_30d)}
        </dd>
      </dl>
    </div>
  );
}

export function ProvidersPanel({ usage }: { usage: ProvidersUsageResponse }) {
  const { t } = useTranslation('common');
  const [mode, setMode] = useState<Mode>(readMode);
  const [picked, setPicked] = useState<string | null>(null);
  const { providers, without_login } = usage;
  const selected =
    providers.find((p) => p.agent === picked) ?? providers[0] ?? null;

  const changeMode = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Per-viewer convenience only.
    }
  };

  return (
    <Panel
      title={t('dashboard.providers.title')}
      chip={t('dashboard.providers.withLogin', { count: providers.length })}
      aside={
        <span className="inline-flex overflow-hidden rounded-md border border-border">
          {(['all', 'one'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => changeMode(m)}
              className={cn(
                'px-2 py-0.5 text-xs',
                mode === m
                  ? 'bg-secondary text-high'
                  : 'text-low hover:text-high'
              )}
            >
              {t(`dashboard.providers.mode.${m}`)}
            </button>
          ))}
        </span>
      }
    >
      <div className="p-3">
        {providers.length === 0 ? (
          <p className="text-sm text-low">{t('dashboard.providers.none')}</p>
        ) : mode === 'all' ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
            {providers.map((p) => (
              <ProviderCard key={p.agent} provider={p} />
            ))}
          </div>
        ) : (
          <>
            <div
              role="group"
              aria-label={t('dashboard.providers.pick')}
              className="inline-flex flex-wrap overflow-hidden rounded-md border border-border"
            >
              {providers.map((p) => {
                const on = p.agent === selected?.agent;
                const max = Math.max(0, ...p.meters.map((m) => m.used_percent));
                return (
                  <button
                    key={p.agent}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked(p.agent)}
                    className={cn(
                      'inline-flex items-center gap-2 border-r border-border px-3.5 py-1.5 text-sm last:border-r-0',
                      on ? 'bg-secondary text-high' : 'text-low hover:text-high'
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        DOT_CLASS[p.agent] ?? 'bg-md-outline'
                      )}
                    />
                    {agentLabel(p.agent)}
                    <span
                      className={cn(
                        'font-mono text-[11px]',
                        p.meters.length
                          ? PCT_CLASS[meterTone(max / 100)]
                          : 'text-low'
                      )}
                    >
                      {p.meters.length ? `${Math.round(max)}%` : '—'}
                    </span>
                  </button>
                );
              })}
            </div>
            {selected && <ProviderDetail provider={selected} />}
          </>
        )}
        {without_login.length > 0 && (
          <p className="mt-3 text-xs text-low">
            {t('dashboard.providers.withoutLogin', {
              agents: without_login.map(agentLabel).join(', '),
            })}{' '}
            <button
              type="button"
              className="text-brand-on-surface hover:underline"
              onClick={() =>
                void SettingsDialog.show({ initialSection: 'agents' })
              }
            >
              {t('dashboard.providers.configure')}
            </button>
          </p>
        )}
      </div>
    </Panel>
  );
}
