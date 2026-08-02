import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { formatManHours } from '@/features/dashboard/model/dashboardMetrics';
import {
  VALUE_HISTORY_WINDOWS,
  useValueGenerated,
  type ValueGeneratedMonth,
} from '@/features/dashboard/model/useValueGenerated';
import {
  DEFAULT_HOURS_PER_FTE_MONTH,
  DEFAULT_HOURS_PER_TASK,
  MAX_HOURS_PER_FTE_MONTH,
  MAX_HOURS_PER_TASK,
  MIN_HOURS_PER_FTE_MONTH,
  MIN_HOURS_PER_TASK,
  useValueGeneratedSettingsStore,
} from '@/features/dashboard/model/useValueGeneratedSettingsStore';
import { Panel, PanelEmpty } from './parts/primitives';

/**
 * Turn a monthly bucket into the aggregate figures the panel shows.
 *
 * Tasks with an override contribute their stored hours verbatim; tasks
 * without one get the viewer's default. Kept as a plain function so the
 * "this month" and each history row use identical math.
 */
function computeMonthMetrics(
  month: ValueGeneratedMonth,
  hoursPerTask: number,
  hoursPerFteMonth: number
): { hours: number; fte: number } {
  const withoutOverride = Math.max(
    0,
    month.done_count - month.tasks_with_override
  );
  const hours = month.override_hours_sum + withoutOverride * hoursPerTask;
  const fte = hoursPerFteMonth > 0 ? hours / hoursPerFteMonth : 0;
  return { hours, fte };
}

/**
 * "Value generated" narrative: how many tickets closed this month, how many
 * man-hours that represents, and the FTE-equivalent of that time.
 *
 * Self-contained: owns its query and its settings so the rest of the
 * dashboard state doesn't grow another concern.
 */
export function ValueGeneratedPanel() {
  const { t, i18n } = useTranslation('common');

  const hoursPerTask = useValueGeneratedSettingsStore((s) => s.hoursPerTask);
  const setHoursPerTask = useValueGeneratedSettingsStore(
    (s) => s.setHoursPerTask
  );
  const hoursPerFteMonth = useValueGeneratedSettingsStore(
    (s) => s.hoursPerFteMonth
  );
  const setHoursPerFteMonth = useValueGeneratedSettingsStore(
    (s) => s.setHoursPerFteMonth
  );
  const historyMonths = useValueGeneratedSettingsStore((s) => s.historyMonths);
  const setHistoryMonths = useValueGeneratedSettingsStore(
    (s) => s.setHistoryMonths
  );

  const { summary, isLoading } = useValueGenerated(historyMonths);

  const [hoursDraft, setHoursDraft] = useState(() => String(hoursPerTask));
  const [fteDraft, setFteDraft] = useState(() => String(hoursPerFteMonth));

  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        year: 'numeric',
      }),
    [i18n.language]
  );

  const currentMonth: ValueGeneratedMonth = summary.months[0] ?? {
    year_month: monthKey(new Date()),
    done_count: 0,
    tasks_with_override: 0,
    override_hours_sum: 0,
  };
  const historyMonthsRows = summary.months.slice(1);

  const currentMetrics = computeMonthMetrics(
    currentMonth,
    hoursPerTask,
    hoursPerFteMonth
  );

  const totals = useMemo(() => {
    return summary.months.reduce(
      (acc, month) => {
        const metrics = computeMonthMetrics(
          month,
          hoursPerTask,
          hoursPerFteMonth
        );
        acc.tickets += month.done_count;
        acc.hours += metrics.hours;
        acc.fte += metrics.fte;
        return acc;
      },
      { tickets: 0, hours: 0, fte: 0 }
    );
  }, [summary.months, hoursPerTask, hoursPerFteMonth]);

  const commitHoursPerTask = (raw: string) => {
    setHoursDraft(raw);
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_HOURS_PER_TASK &&
      parsed <= MAX_HOURS_PER_TASK
    ) {
      setHoursPerTask(parsed);
    }
  };
  const normaliseHoursPerTask = () => {
    const parsed = Number.parseFloat(hoursDraft);
    const next = Number.isFinite(parsed)
      ? Math.min(MAX_HOURS_PER_TASK, Math.max(MIN_HOURS_PER_TASK, parsed))
      : DEFAULT_HOURS_PER_TASK;
    setHoursPerTask(next);
    setHoursDraft(String(next));
  };

  const commitHoursPerFte = (raw: string) => {
    setFteDraft(raw);
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_HOURS_PER_FTE_MONTH &&
      parsed <= MAX_HOURS_PER_FTE_MONTH
    ) {
      setHoursPerFteMonth(parsed);
    }
  };
  const normaliseHoursPerFte = () => {
    const parsed = Number.parseFloat(fteDraft);
    const next = Number.isFinite(parsed)
      ? Math.min(
          MAX_HOURS_PER_FTE_MONTH,
          Math.max(MIN_HOURS_PER_FTE_MONTH, parsed)
        )
      : DEFAULT_HOURS_PER_FTE_MONTH;
    setHoursPerFteMonth(next);
    setFteDraft(String(next));
  };

  const head = (
    <span className="flex flex-wrap items-center gap-2.5">
      <span
        className="flex gap-0.5 rounded-full bg-secondary p-0.5"
        role="group"
        aria-label={t('dashboard.valueGenerated.windowLabel')}
      >
        {VALUE_HISTORY_WINDOWS.map((months) => (
          <button
            key={months}
            type="button"
            aria-pressed={months === historyMonths}
            onClick={() => setHistoryMonths(months)}
            className={cn(
              'rounded-full px-2 py-px text-xs font-semibold normal-case tracking-normal tabular-nums',
              months === historyMonths
                ? 'bg-card text-high'
                : 'text-low hover:text-normal'
            )}
          >
            {t('dashboard.valueGenerated.windowMonths', { months })}
          </button>
        ))}
      </span>
      <label className="flex items-center gap-1.5 text-xs font-normal normal-case tracking-normal text-low">
        <input
          type="number"
          min={MIN_HOURS_PER_TASK}
          max={MAX_HOURS_PER_TASK}
          step={0.5}
          value={hoursDraft}
          aria-label={t('dashboard.valueGenerated.hoursPerTaskLabel')}
          onChange={(event) => commitHoursPerTask(event.target.value)}
          onBlur={normaliseHoursPerTask}
          className="w-12 rounded border border-border bg-md-background px-1.5 py-px text-right text-xs text-high tabular-nums"
        />
        {t('dashboard.valueGenerated.hoursPerTask')}
      </label>
      <label className="flex items-center gap-1.5 text-xs font-normal normal-case tracking-normal text-low">
        <input
          type="number"
          min={MIN_HOURS_PER_FTE_MONTH}
          max={MAX_HOURS_PER_FTE_MONTH}
          step={10}
          value={fteDraft}
          aria-label={t('dashboard.valueGenerated.hoursPerFteLabel')}
          onChange={(event) => commitHoursPerFte(event.target.value)}
          onBlur={normaliseHoursPerFte}
          className="w-14 rounded border border-border bg-md-background px-1.5 py-px text-right text-xs text-high tabular-nums"
        />
        {t('dashboard.valueGenerated.hoursPerFte')}
      </label>
    </span>
  );

  return (
    <Panel title={t('dashboard.valueGenerated.title')} aside={head}>
      <div className="flex flex-col gap-3 p-3">
        <CurrentMonthCard
          month={currentMonth}
          hours={currentMetrics.hours}
          fte={currentMetrics.fte}
          monthFormatter={monthFormatter}
        />

        {totals.tickets > 0 && historyMonths > 1 && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-low">
            <span className="font-sans text-label font-semibold uppercase tracking-wide">
              {t('dashboard.valueGenerated.totalsLabel', {
                months: historyMonths,
              })}
            </span>
            <span className="tabular-nums text-normal">
              {t('dashboard.valueGenerated.totalsTickets', {
                count: totals.tickets,
              })}
            </span>
            <span className="tabular-nums text-normal">
              {t('dashboard.valueGenerated.totalsHours', {
                hours: formatManHours(totals.hours),
              })}
            </span>
            <span className="tabular-nums text-normal">
              {t('dashboard.valueGenerated.totalsFte', {
                fte: formatManHours(totals.fte),
              })}
            </span>
          </div>
        )}

        {historyMonthsRows.length === 0 ? (
          <PanelEmpty>
            {isLoading
              ? t('dashboard.valueGenerated.loading')
              : t('dashboard.valueGenerated.emptyHistory')}
          </PanelEmpty>
        ) : (
          <HistoryTable
            rows={historyMonthsRows}
            hoursPerTask={hoursPerTask}
            hoursPerFteMonth={hoursPerFteMonth}
            monthFormatter={monthFormatter}
          />
        )}
      </div>
    </Panel>
  );
}

function CurrentMonthCard({
  month,
  hours,
  fte,
  monthFormatter,
}: {
  month: ValueGeneratedMonth;
  hours: number;
  fte: number;
  monthFormatter: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('common');
  const monthLabel = monthFormatter.format(parseMonthKey(month.year_month));

  return (
    <div className="rounded-md border border-border bg-md-background/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-sans text-label font-semibold uppercase tracking-wide text-low">
          {t('dashboard.valueGenerated.thisMonthLabel', { month: monthLabel })}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-sans text-2xl font-bold leading-tight tracking-tight text-high tabular-nums">
          {t('dashboard.valueGenerated.summaryTickets', {
            count: month.done_count,
          })}
        </span>
        <span className="text-sm text-normal tabular-nums">
          {t('dashboard.valueGenerated.summaryHours', {
            hours: formatManHours(hours),
          })}
        </span>
        <span className="text-sm text-normal tabular-nums">
          {t('dashboard.valueGenerated.summaryFte', {
            fte: formatManHours(fte),
          })}
        </span>
      </div>
    </div>
  );
}

function HistoryTable({
  rows,
  hoursPerTask,
  hoursPerFteMonth,
  monthFormatter,
}: {
  rows: ValueGeneratedMonth[];
  hoursPerTask: number;
  hoursPerFteMonth: number;
  monthFormatter: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[24rem] border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-left font-sans text-label font-semibold uppercase tracking-wide text-low">
            <th className="py-1 pr-2 font-semibold">
              {t('dashboard.valueGenerated.tableMonth')}
            </th>
            <th className="py-1 pr-2 text-right font-semibold">
              {t('dashboard.valueGenerated.tableTickets')}
            </th>
            <th className="py-1 pr-2 text-right font-semibold">
              {t('dashboard.valueGenerated.tableHours')}
            </th>
            <th className="py-1 text-right font-semibold">
              {t('dashboard.valueGenerated.tableFte')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((month) => {
            const metrics = computeMonthMetrics(
              month,
              hoursPerTask,
              hoursPerFteMonth
            );
            return (
              <tr
                key={month.year_month}
                className="border-t border-border text-normal"
              >
                <td className="border-t border-border py-1 pr-2 text-low">
                  {monthFormatter.format(parseMonthKey(month.year_month))}
                </td>
                <td className="border-t border-border py-1 pr-2 text-right tabular-nums">
                  {month.done_count}
                </td>
                <td className="border-t border-border py-1 pr-2 text-right tabular-nums">
                  {formatManHours(metrics.hours)}
                </td>
                <td className="border-t border-border py-1 text-right tabular-nums">
                  {formatManHours(metrics.fte)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** `YYYY-MM` -> local `Date` for the 1st of that month. */
function parseMonthKey(key: string): Date {
  const [year, month] = key.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return new Date();
  return new Date(year, month - 1, 1);
}

/** Local calendar month key, `YYYY-MM`. */
function monthKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}
