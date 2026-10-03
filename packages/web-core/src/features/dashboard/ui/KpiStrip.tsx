import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import {
  formatManHours,
  parseSqliteUtc,
  ticketHours,
  agentLabel,
  formatResetAt,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'warning';
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-3">
      <span className="truncate font-sans text-label uppercase tracking-wide text-low">
        {label}
      </span>
      <span
        className={cn(
          'truncate font-sans text-heading leading-none tabular-nums',
          tone === 'warning' ? 'text-warning' : 'text-high'
        )}
      >
        {value}
      </span>
      <span className="min-h-4 truncate text-xs text-low">{sub}</span>
    </div>
  );
}

export function KpiStrip({
  data,
  attentionCount,
  attentionSummary,
  hoursPerTicket,
}: {
  data: DashboardData;
  attentionCount: number;
  attentionSummary: string;
  hoursPerTicket: number;
}) {
  const { t } = useTranslation('common');
  const { overview, tickets, providers } = data;

  const today = new Date().toDateString();
  const todayTickets = tickets.filter(
    (tk) =>
      tk.resolved_at && parseSqliteUtc(tk.resolved_at).toDateString() === today
  );
  const todayCost = todayTickets.reduce((sum, tk) => sum + tk.cost_usd, 0);
  const todayHours = todayTickets.reduce(
    (sum, tk) => sum + ticketHours(tk, hoursPerTicket),
    0
  );

  const activeRepos = (overview?.repos ?? []).filter(
    (r) => r.running > 0 || r.milestone !== null
  );

  let closest: { pct: number; label: string } | null = null;
  for (const provider of providers?.providers ?? []) {
    for (const meter of provider.meters) {
      if (closest && closest.pct >= meter.used_percent) continue;
      const reset = formatResetAt(meter.resets_at);
      closest = {
        pct: meter.used_percent,
        label: [
          `${agentLabel(provider.agent)} ${t(`dashboard.providers.meter.${meter.key}`, { defaultValue: meter.key })}`,
          reset,
        ]
          .filter(Boolean)
          .join(', '),
      };
    }
  }

  const used = overview?.slots_used ?? 0;
  const limit = overview?.slots_limit ?? 0;

  return (
    <section
      aria-label={t('dashboard.summarySection')}
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
    >
      <StatCard
        label={t('dashboard.kpi.slots')}
        value={limit > 0 ? `${used} / ${limit}` : used}
        sub={t('dashboard.kpi.queued', {
          count: overview?.queued.length ?? 0,
        })}
      />
      <StatCard
        label={t('dashboard.kpi.attention')}
        value={attentionCount}
        tone={attentionCount > 0 ? 'warning' : undefined}
        sub={attentionSummary}
      />
      <StatCard
        label={t('dashboard.kpi.activeRepos')}
        value={t('dashboard.kpi.ofTotal', {
          count: activeRepos.length,
          total: overview?.repos.length ?? 0,
        })}
        sub={activeRepos.map((r) => r.name).join(', ')}
      />
      <StatCard
        label={t('dashboard.kpi.resolvedToday')}
        value={t('dashboard.kpi.tickets', { count: todayTickets.length })}
        sub={t('dashboard.kpi.hoursSaved', {
          hours: formatManHours(todayHours),
        })}
      />
      <StatCard
        label={t('dashboard.kpi.costToday')}
        value={usdFormatter.format(todayCost)}
        sub={
          todayTickets.length > 0 &&
          t('dashboard.kpi.perTicket', {
            cost: usdFormatter.format(todayCost / todayTickets.length),
          })
        }
      />
      <StatCard
        label={t('dashboard.kpi.closestLimit')}
        value={closest ? `${Math.round(closest.pct)}%` : '—'}
        tone={closest && closest.pct >= 70 ? 'warning' : undefined}
        sub={closest?.label}
      />
    </section>
  );
}
