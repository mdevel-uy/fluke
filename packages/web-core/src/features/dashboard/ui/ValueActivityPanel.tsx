import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Ticket } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { workersApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  DEFAULT_CURRENCY,
  DEFAULT_HOURLY_RATE,
  DEFAULT_HOURS_PER_TASK,
  MAX_HOURS_PER_TASK,
  MIN_HOURS_PER_TASK,
  normalizeCurrency,
} from '@/features/dashboard/model/valueDefaults';
import {
  formatManHours,
  parseSqliteUtc,
  ticketHours,
  ticketsByMonth,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import {
  FEED_WINDOW_MS,
  type FeedEvent,
} from '@/features/dashboard/model/useDashboardData';
import { Panel } from './parts/primitives';

const FEED_PAGE = 10;
const HISTORY_MONTHS = 6;

const EVENT_DOT: Record<FeedEvent['kind'] | 'ticket', string> = {
  ticket: 'bg-success',
  pr_opened: 'bg-brand',
  pr_merged: 'bg-merged',
  approval: 'bg-warning',
  failed: 'bg-error',
};

type FeedRow =
  | { key: string; time: Date; type: 'ticket'; ticket: Ticket }
  | { key: string; time: Date; type: 'event'; event: FeedEvent };

/** Hours of a ticket, editable in place; empty clears the override. */
function HoursInput({
  ticket,
  hours,
  onSave,
}: {
  ticket: Ticket;
  hours: number;
  onSave: (value: number | null) => void;
}) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === '') return onSave(null);
    const value = Number(raw.replace(',', '.'));
    if (
      Number.isFinite(value) &&
      value >= MIN_HOURS_PER_TASK &&
      value <= MAX_HOURS_PER_TASK &&
      value !== hours
    )
      onSave(value);
  };
  return (
    <label className="inline-flex items-center gap-1 rounded border border-border bg-primary px-1.5 font-mono text-xs text-high">
      <input
        type="text"
        inputMode="decimal"
        disabled={!ticket.edit_task_id}
        aria-label={t('dashboard.value.hoursLabel')}
        value={draft ?? formatManHours(hours)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-8 bg-transparent text-right outline-none"
      />
      h
    </label>
  );
}

export function ValueActivityPanel({
  tickets,
  events,
}: {
  tickets: Ticket[];
  events: FeedEvent[];
}) {
  const { t, i18n } = useTranslation('common');
  const { config } = useUserSystem();
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const hoursPerTicket =
    config?.default_hours_saved_per_task ?? DEFAULT_HOURS_PER_TASK;
  const rate = config?.default_hourly_rate ?? DEFAULT_HOURLY_RATE;
  const money = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: 'currency',
        currency: normalizeCurrency(config?.default_currency, DEFAULT_CURRENCY),
        maximumFractionDigits: 0,
      }),
    [i18n.language, config?.default_currency]
  );

  const save = useMutation({
    mutationFn: (input: { ticket: Ticket; value: number | null }) =>
      workersApi.updateTask(
        input.ticket.edit_worker_id!,
        input.ticket.edit_task_id!,
        { hours_saved_override: input.value }
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'tickets'] }),
  });

  const months = useMemo(
    () => ticketsByMonth(tickets, HISTORY_MONTHS, hoursPerTicket),
    [tickets, hoursPerTicket]
  );
  const current = months[0];
  const monthFmt = new Intl.DateTimeFormat(i18n.language, { month: 'short' });
  const longMonthFmt = new Intl.DateTimeFormat(i18n.language, {
    month: 'long',
  });

  const groups = useMemo(() => {
    const cutoff = Date.now() - FEED_WINDOW_MS;
    const rows: FeedRow[] = [
      ...tickets
        .filter((tk) => tk.resolved_at)
        .map((tk) => ({
          key: `ticket-${tk.key}`,
          time: parseSqliteUtc(tk.resolved_at!),
          type: 'ticket' as const,
          ticket: tk,
        }))
        .filter((r) => r.time.getTime() >= cutoff),
      ...events.map((e) => ({
        key: e.key,
        time: e.time,
        type: 'event' as const,
        event: e,
      })),
    ].sort((a, b) => b.time.getTime() - a.time.getTime());
    const shown = showAll ? rows : rows.slice(0, FEED_PAGE);
    const today = new Date().toDateString();
    const byDay: { day: string; rows: FeedRow[] }[] = [];
    for (const row of shown) {
      const day =
        row.time.toDateString() === today
          ? t('dashboard.value.today')
          : t('dashboard.value.yesterday');
      if (byDay.at(-1)?.day !== day) byDay.push({ day, rows: [] });
      byDay.at(-1)!.rows.push(row);
    }
    return { byDay, more: rows.length > FEED_PAGE };
  }, [tickets, events, showAll, t]);

  const timeFmt = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Panel
      title={t('dashboard.value.title')}
      aside={
        <button
          type="button"
          className="hover:text-high hover:underline"
          onClick={() =>
            void SettingsDialog.show({ initialSection: 'billing' })
          }
        >
          {t('dashboard.value.basis', {
            hours: formatManHours(hoursPerTicket),
            rate: money.format(rate),
          })}
        </button>
      }
    >
      <div className="grid gap-4 p-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-3.5 grid grid-cols-2 gap-2 md:grid-cols-4">
            <MonthCard
              label={t('dashboard.value.monthCurrent', {
                month: longMonthFmt.format(current.date),
              })}
              value={current.count}
              sub={t('dashboard.value.ticketsResolved')}
            />
            <MonthCard
              label={t('dashboard.value.hoursSaved')}
              value={`${formatManHours(current.hours)} h`}
              sub={t('dashboard.value.hoursBasis', {
                count: current.count,
                hours: formatManHours(hoursPerTicket),
              })}
            />
            <MonthCard
              label={t('dashboard.value.valueGenerated')}
              value={money.format(current.hours * rate)}
              sub={t('dashboard.value.valueBasis', {
                hours: formatManHours(current.hours),
                rate: money.format(rate),
              })}
              className="text-success"
            />
            <MonthCard
              label={t('dashboard.value.aiCost')}
              value={usdFormatter.format(current.cost)}
              sub={t('dashboard.value.apiEquivalent')}
              className="text-warning"
            />
          </div>

          {groups.byDay.length === 0 ? (
            <p className="py-3 text-sm text-low">
              {t('dashboard.value.feedEmpty')}
            </p>
          ) : (
            groups.byDay.map((group) => (
              <div key={group.day}>
                <div className="pb-1.5 pt-2.5 font-mono text-[11px] font-medium uppercase tracking-wide text-low">
                  {group.day}
                </div>
                {group.rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex flex-wrap items-center gap-2.5 border-b border-border py-2 text-sm"
                  >
                    <span className="w-16 shrink-0 whitespace-nowrap font-mono text-[11px] text-low">
                      {timeFmt.format(row.time)}
                    </span>
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        EVENT_DOT[
                          row.type === 'ticket' ? 'ticket' : row.event.kind
                        ]
                      )}
                    />
                    {row.type === 'ticket' ? (
                      <TicketFeedRow
                        ticket={row.ticket}
                        hours={ticketHours(row.ticket, hoursPerTicket)}
                        value={money.format(
                          ticketHours(row.ticket, hoursPerTicket) * rate
                        )}
                        onSave={(value) =>
                          save.mutate({ ticket: row.ticket, value })
                        }
                      />
                    ) : (
                      <span className="min-w-0 flex-[1_1_260px] text-normal">
                        {t(`dashboard.value.event.${row.event.kind}`, {
                          label: row.event.label,
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
          {groups.more && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-2.5 text-sm text-brand-on-surface hover:underline"
            >
              {showAll
                ? t('dashboard.value.showLess')
                : t('dashboard.value.showAll')}
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2.5">
          <span className="font-sans text-label font-semibold uppercase tracking-wide text-low">
            {t('dashboard.value.history')}
          </span>
          <table className="w-full border-collapse font-mono text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-[10.5px] uppercase tracking-wide text-low">
                <th className="px-2 py-1.5 text-left font-medium">
                  {t('dashboard.value.col.month')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('dashboard.value.col.tickets')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('dashboard.value.col.hours')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('dashboard.value.col.value')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('dashboard.value.col.cost')}
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr
                  key={m.key}
                  className={cn(
                    'border-b border-border text-normal',
                    i === 0 && 'bg-brand/5 text-high'
                  )}
                >
                  <td className="px-2 py-2">{monthFmt.format(m.date)}</td>
                  <td className="px-2 py-2 text-right">{m.count}</td>
                  <td className="px-2 py-2 text-right">
                    {formatManHours(m.hours)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {money.format(m.hours * rate)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {usdFormatter.format(m.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="text-xs text-low">
            {t('dashboard.value.historyHint')}
          </small>
        </div>
      </div>
    </Panel>
  );
}

function TicketFeedRow({
  ticket,
  hours,
  value,
  onSave,
}: {
  ticket: Ticket;
  hours: number;
  value: string;
  onSave: (value: number | null) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <>
      <span className="min-w-0 flex-[1_1_260px] text-normal">
        {t('dashboard.value.event.ticket', {
          label:
            ticket.issue_number != null
              ? `#${ticket.issue_number} ${ticket.title}`
              : ticket.title,
        })}
      </span>
      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
        <HoursInput ticket={ticket} hours={hours} onSave={onSave} />
        <span className="text-success">{value}</span>
        <span className="text-warning">
          {usdFormatter.format(ticket.cost_usd)}
        </span>
      </span>
    </>
  );
}

function MonthCard({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
      <small className="truncate text-[11.5px] text-low first-letter:uppercase">
        {label}
      </small>
      <b className={cn('text-lg font-semibold text-high', className)}>
        {value}
      </b>
      <small className="truncate text-[11.5px] text-low">{sub}</small>
    </div>
  );
}
