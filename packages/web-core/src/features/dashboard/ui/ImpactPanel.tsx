import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Ticket } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import {
  bucketTicketsByDay,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import { Panel, PanelEmpty } from './parts/primitives';

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

/** Chart drawing box; stretched to the container width. */
const W = 900;
const H = 200;
const TOP = 20;

/** Round up to 1, 2, 5 × 10^n so the axis has round labels. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((s) => s * pow >= value) ?? 10;
  return step * pow;
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-sm">
      {ticket.issue_number != null && (
        <b className="font-mono text-high">#{ticket.issue_number}</b>
      )}
      <span className="min-w-0 flex-[1_1_200px] truncate text-normal">
        {ticket.title}
      </span>
      <span className="font-mono text-[11px] text-low">
        {t('dashboard.impact.phases', { count: Number(ticket.tasks) })}
      </span>
      <span className="font-mono text-warning">
        {usdFormatter.format(ticket.cost_usd)}
      </span>
    </div>
  );
}

export function ImpactPanel({ tickets }: { tickets: Ticket[] }) {
  const { t, i18n } = useTranslation('common');
  const [windowDays, setWindowDays] = useState<Window>(30);
  const buckets = useMemo(
    () => bucketTicketsByDay(tickets, windowDays),
    [tickets, windowDays]
  );
  const [picked, setPicked] = useState<string | null>(null);
  const day =
    buckets.find((b) => b.dayKey === picked) ??
    [...buckets].reverse().find((b) => b.count > 0) ??
    buckets[buckets.length - 1];

  const maxCount = niceMax(Math.max(...buckets.map((b) => b.count)));
  const avg = (b: (typeof buckets)[number]) => (b.count ? b.cost / b.count : 0);
  const maxCost = niceMax(Math.max(...buckets.map(avg)));
  const slot = W / buckets.length;
  const barW = Math.max(2, slot * 0.6);
  const y = (v: number, max: number) => H - (v / max) * (H - TOP);

  const bar = (i: number, count: number) =>
    `M${i * slot + (slot - barW) / 2} ${y(count, maxCount)}h${barW}V${H}h${-barW}Z`;
  const bars = buckets.map((b, i) => (b.count ? bar(i, b.count) : '')).join('');
  const line = buckets
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.count > 0)
    .map(
      ({ b, i }, k) =>
        `${k ? 'L' : 'M'}${i * slot + slot / 2} ${y(avg(b), maxCost)}`
    )
    .join('');
  const dayIndex = buckets.indexOf(day);

  const tickFmt = new Intl.DateTimeFormat(i18n.language, {
    day: 'numeric',
    month: 'short',
  });
  const dayFmt = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const tickIdx = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    Math.round(f * (buckets.length - 1))
  );
  const axis = (max: number) => [1, 0.8, 0.6, 0.4, 0.2, 0].map((f) => f * max);

  const inWindow = buckets.flatMap((b) => b.tickets);
  const top = [...inWindow].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 5);

  return (
    <Panel
      title={t('dashboard.impact.title')}
      aside={
        <span className="inline-flex overflow-hidden rounded-md border border-border">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={windowDays === w}
              onClick={() => setWindowDays(w)}
              className={cn(
                'px-2 py-0.5 text-xs',
                windowDays === w
                  ? 'bg-secondary text-high'
                  : 'text-low hover:text-high'
              )}
            >
              {t('dashboard.impact.days', { count: w })}
            </button>
          ))}
        </span>
      }
    >
      {inWindow.length === 0 ? (
        <PanelEmpty>{t('dashboard.impact.empty')}</PanelEmpty>
      ) : (
        <div className="grid gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <div className="mb-2.5 flex flex-wrap gap-3.5 text-xs text-low">
              <span className="inline-flex items-center gap-1.5">
                <i className="inline-block h-2 w-3 rounded-sm bg-brand" />
                {t('dashboard.impact.legendTickets')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="inline-block h-0.5 w-3 bg-warning" />
                {t('dashboard.impact.legendCost')}
              </span>
            </div>

            <div className="relative h-[230px]">
              <div className="absolute left-0 top-0 flex h-[200px] flex-col justify-between font-mono text-[10px] text-low">
                {axis(maxCount).map((v) => (
                  <span key={v}>{Math.round(v)}</span>
                ))}
              </div>
              <div className="absolute right-0 top-0 flex h-[200px] flex-col justify-between text-right font-mono text-[10px] text-warning">
                {axis(maxCost).map((v) => (
                  <span key={v}>${v < 10 ? v.toFixed(1) : Math.round(v)}</span>
                ))}
              </div>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                aria-hidden
                className="absolute left-[34px] right-[44px] top-0 h-[200px] w-[calc(100%-78px)] overflow-visible"
              >
                {[0.2, 0.4, 0.6, 0.8].map((f) => (
                  <path
                    key={f}
                    d={`M0 ${y(f * maxCount, maxCount)}H${W}`}
                    className="stroke-md-outline-variant/60"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path d={bars} className="fill-brand opacity-55" />
                {day.count > 0 && (
                  <path d={bar(dayIndex, day.count)} className="fill-brand" />
                )}
                <path
                  d={line}
                  className="fill-none stroke-warning"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <div className="absolute left-[34px] right-[44px] top-0 flex h-[200px]">
                {buckets.map((b) => (
                  <button
                    key={b.dayKey}
                    type="button"
                    aria-label={t('dashboard.impact.dayLabel', {
                      day: tickFmt.format(b.date),
                      count: b.count,
                    })}
                    onClick={() => setPicked(b.dayKey)}
                    className="flex-1 rounded-sm hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                  />
                ))}
              </div>
              <div className="absolute bottom-1.5 left-[34px] right-[44px] flex justify-between font-mono text-[10px] text-low">
                {tickIdx.map((i) => (
                  <span key={i}>{tickFmt.format(buckets[i].date)}</span>
                ))}
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <b className="text-sm font-semibold text-high first-letter:uppercase">
                  {dayFmt.format(day.date)}
                </b>
                {day.count > 0 && (
                  <span className="text-xs text-low">
                    {t('dashboard.impact.daySummary', {
                      count: day.count,
                      total: usdFormatter.format(day.cost),
                      avg: usdFormatter.format(avg(day)),
                    })}
                  </span>
                )}
              </div>
              {day.count === 0 ? (
                <span className="text-sm text-low">
                  {t('dashboard.impact.dayEmpty')}
                </span>
              ) : (
                day.tickets.map((tk) => <TicketRow key={tk.key} ticket={tk} />)
              )}
            </div>
            <p className="mt-2.5 text-xs text-low">
              {t('dashboard.impact.footnote')}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-sans text-label font-semibold uppercase tracking-wide text-low">
              {t('dashboard.impact.top', { count: windowDays })}
            </span>
            {top.map((tk) => (
              <div
                key={tk.key}
                className="rounded-md border border-border bg-secondary/40 px-2.5 py-2"
              >
                <TicketRow ticket={tk} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
