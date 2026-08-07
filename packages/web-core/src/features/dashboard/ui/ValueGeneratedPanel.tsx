import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
import {
  DEFAULT_CURRENCY,
  DEFAULT_HOURLY_RATE,
  normalizeCurrency,
} from '@/features/dashboard/model/valueDefaults';
import { formatManHours } from '@/features/dashboard/model/dashboardMetrics';
import {
  VALUE_HISTORY_WINDOWS,
  useValueGenerated,
} from '@/features/dashboard/model/useValueGenerated';
import { useCompletedTasksSince } from '@/features/dashboard/model/useCompletedTasks';
import {
  DEFAULT_HOURS_PER_FTE_MONTH,
  DEFAULT_HOURS_PER_TASK,
  MAX_HOURS_PER_FTE_MONTH,
  MAX_HOURS_PER_TASK,
  MIN_HOURS_PER_FTE_MONTH,
  MIN_HOURS_PER_TASK,
  clampHoursPerFteMonth,
  clampHoursPerTask,
  useValueGeneratedSettingsStore,
} from '@/features/dashboard/model/useValueGeneratedSettingsStore';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { workersApi } from '@/shared/lib/api';
import type {
  CompletedWorkerTask,
  ValueGeneratedMonth,
  WorkerTaskResponse,
} from 'shared/types';
import { Panel, PanelEmpty } from './parts/primitives';

/**
 * Turn a monthly bucket into the aggregate figures the panel shows.
 *
 * Tasks with an override contribute their stored hours verbatim; tasks
 * without one get the installation default. Kept as a plain function so
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
 * Self-contained: owns its query and reads the installation-wide defaults
 * from the server config so every viewer sees the same authoritative
 * pricing figure.
 */
export function ValueGeneratedPanel() {
  const { t, i18n } = useTranslation('common');
  const { config, updateAndSaveConfig } = useUserSystem();

  const historyMonths = useValueGeneratedSettingsStore((s) => s.historyMonths);
  const setHistoryMonths = useValueGeneratedSettingsStore(
    (s) => s.setHistoryMonths
  );

  const { summary, isLoading } = useValueGenerated(historyMonths);

  // Defaults live server-side (`Config.default_hours_saved_per_task`,
  // `Config.default_hours_per_fte_month`, `Config.default_hourly_rate`,
  // `Config.default_currency`) so the pricing figure does not diverge
  // across viewers. Fall back to the client defaults only while the
  // config is still loading.
  const hoursPerTask =
    config?.default_hours_saved_per_task ?? DEFAULT_HOURS_PER_TASK;
  const hoursPerFteMonth =
    config?.default_hours_per_fte_month ?? DEFAULT_HOURS_PER_FTE_MONTH;
  const hourlyRate = config?.default_hourly_rate ?? DEFAULT_HOURLY_RATE;
  const currency = normalizeCurrency(
    config?.default_currency,
    DEFAULT_CURRENCY
  );

  const currencyFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }),
    [i18n.language, currency]
  );

  const [hoursDraft, setHoursDraft] = useState(() => String(hoursPerTask));
  const [fteDraft, setFteDraft] = useState(() => String(hoursPerFteMonth));
  const [editingTasks, setEditingTasks] = useState(false);

  // Re-hydrate the input drafts when the server figure changes (initial
  // load, or a sibling tab updated the config). Skipped while the user is
  // mid-edit — the draft they typed always wins over an incoming push.
  useEffect(() => {
    setHoursDraft((draft) =>
      Number.parseFloat(draft) === hoursPerTask ? draft : String(hoursPerTask)
    );
  }, [hoursPerTask]);
  useEffect(() => {
    setFteDraft((draft) =>
      Number.parseFloat(draft) === hoursPerFteMonth
        ? draft
        : String(hoursPerFteMonth)
    );
  }, [hoursPerFteMonth]);

  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    [i18n.language]
  );

  const currentMonth: ValueGeneratedMonth = summary.months[0] ?? {
    year_month: currentUtcMonthKey(),
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
        acc.value += metrics.hours * hourlyRate;
        return acc;
      },
      { tickets: 0, hours: 0, fte: 0, value: 0 }
    );
  }, [summary.months, hoursPerTask, hoursPerFteMonth, hourlyRate]);

  const commitHoursPerTask = (raw: string) => {
    setHoursDraft(raw);
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_HOURS_PER_TASK &&
      parsed <= MAX_HOURS_PER_TASK &&
      parsed !== hoursPerTask
    ) {
      void updateAndSaveConfig({ default_hours_saved_per_task: parsed });
    }
  };
  const normaliseHoursPerTask = () => {
    const parsed = Number.parseFloat(hoursDraft);
    const next = clampHoursPerTask(parsed);
    if (next !== hoursPerTask) {
      void updateAndSaveConfig({ default_hours_saved_per_task: next });
    }
    setHoursDraft(String(next));
  };

  const commitHoursPerFte = (raw: string) => {
    setFteDraft(raw);
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_HOURS_PER_FTE_MONTH &&
      parsed <= MAX_HOURS_PER_FTE_MONTH &&
      parsed !== hoursPerFteMonth
    ) {
      void updateAndSaveConfig({ default_hours_per_fte_month: parsed });
    }
  };
  const normaliseHoursPerFte = () => {
    const parsed = Number.parseFloat(fteDraft);
    const next = clampHoursPerFteMonth(parsed);
    if (next !== hoursPerFteMonth) {
      void updateAndSaveConfig({ default_hours_per_fte_month: next });
    }
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
          value={currentMetrics.hours * hourlyRate}
          currencyFormatter={currencyFormatter}
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
            <span className="tabular-nums text-normal">
              {t('dashboard.valueGenerated.totalsValue', {
                value: currencyFormatter.format(totals.value),
              })}
            </span>
          </div>
        )}

        {currentMonth.done_count > 0 && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-md-background/40 p-2">
            <button
              type="button"
              onClick={() => setEditingTasks((v) => !v)}
              aria-expanded={editingTasks}
              className="flex items-center gap-1.5 self-start text-xs font-medium text-low hover:text-normal"
            >
              <MaterialIcon
                name={editingTasks ? 'expand_less' : 'expand_more'}
                size="xs"
              />
              {t('dashboard.valueGenerated.overridePerTaskToggle')}
            </button>
            {editingTasks && <TaskOverrideList defaultHours={hoursPerTask} />}
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
            hourlyRate={hourlyRate}
            currencyFormatter={currencyFormatter}
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
  value,
  currencyFormatter,
  monthFormatter,
}: {
  month: ValueGeneratedMonth;
  hours: number;
  fte: number;
  value: number;
  currencyFormatter: Intl.NumberFormat;
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
        {value > 0 && (
          <span className="text-sm text-normal tabular-nums">
            {t('dashboard.valueGenerated.summaryValue', {
              value: currencyFormatter.format(value),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function HistoryTable({
  rows,
  hoursPerTask,
  hoursPerFteMonth,
  hourlyRate,
  currencyFormatter,
  monthFormatter,
}: {
  rows: ValueGeneratedMonth[];
  hoursPerTask: number;
  hoursPerFteMonth: number;
  hourlyRate: number;
  currencyFormatter: Intl.NumberFormat;
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
            <th className="py-1 pr-2 text-right font-semibold">
              {t('dashboard.valueGenerated.tableFte')}
            </th>
            <th className="py-1 text-right font-semibold">
              {t('dashboard.valueGenerated.tableValue')}
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
                <td className="border-t border-border py-1 pr-2 text-right tabular-nums">
                  {formatManHours(metrics.fte)}
                </td>
                <td className="border-t border-border py-1 text-right tabular-nums">
                  {currencyFormatter.format(metrics.hours * hourlyRate)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Editable list of tasks completed since the start of the current UTC
 * calendar month. Each row shows a placeholder with the installation
 * default when the task has no override, and lets the viewer pin an
 * explicit man-hours figure per task (or clear it back to the default).
 */
function TaskOverrideList({ defaultHours }: { defaultHours: number }) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const monthStart = useMemo(() => startOfUtcMonth(new Date()), []);
  const { tasks, isLoading, refetch } = useCompletedTasksSince(monthStart);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ['value-generated', 'summary'],
    });
    refetch();
  }, [queryClient, refetch]);

  const patchMutation = useMutation({
    mutationFn: async (input: {
      task: CompletedWorkerTask;
      value: number | null;
    }): Promise<WorkerTaskResponse> => {
      return workersApi.updateTask(input.task.worker_id, input.task.id, {
        hours_saved_override: input.value,
      });
    },
    onSuccess: invalidate,
  });

  if (isLoading) {
    return (
      <div className="py-2 text-xs italic text-low">
        {t('dashboard.valueGenerated.overridePerTaskLoading')}
      </div>
    );
  }

  const doneTasks = tasks.filter((task) => task.status === 'done');
  if (doneTasks.length === 0) {
    return (
      <div className="py-2 text-xs italic text-low">
        {t('dashboard.valueGenerated.overridePerTaskEmpty')}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {doneTasks.map((task) => (
        <TaskOverrideRow
          key={task.id}
          task={task}
          defaultHours={defaultHours}
          onSubmit={(value) => patchMutation.mutate({ task, value })}
          disabled={patchMutation.isPending}
        />
      ))}
    </ul>
  );
}

function TaskOverrideRow({
  task,
  defaultHours,
  onSubmit,
  disabled,
}: {
  task: CompletedWorkerTask;
  defaultHours: number;
  onSubmit: (value: number | null) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState(() =>
    task.hours_saved_override !== null ? String(task.hours_saved_override) : ''
  );

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (task.hours_saved_override !== null) onSubmit(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(
        task.hours_saved_override !== null
          ? String(task.hours_saved_override)
          : ''
      );
      return;
    }
    const clamped = clampHoursPerTask(parsed);
    setDraft(String(clamped));
    if (clamped !== task.hours_saved_override) onSubmit(clamped);
  };

  return (
    <li className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-md-surface-container">
      <span className="min-w-0 flex-1 truncate text-normal" title={task.title}>
        {task.title}
      </span>
      <input
        type="number"
        min={MIN_HOURS_PER_TASK}
        max={MAX_HOURS_PER_TASK}
        step={0.5}
        value={draft}
        placeholder={String(defaultHours)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        disabled={disabled}
        aria-label={t('dashboard.valueGenerated.overridePerTaskInputLabel')}
        className="w-16 rounded border border-border bg-md-background px-1.5 py-px text-right tabular-nums text-high"
      />
      <span className="w-4 text-low">
        {task.hours_saved_override !== null && (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              onSubmit(null);
            }}
            disabled={disabled}
            aria-label={t('dashboard.valueGenerated.overridePerTaskClear')}
            title={t('dashboard.valueGenerated.overridePerTaskClear')}
            className="inline-flex items-center justify-center hover:text-normal"
          >
            <MaterialIcon name="close" size="xs" />
          </button>
        )}
      </span>
    </li>
  );
}

/** `YYYY-MM` (UTC) -> `Date` at the 1st of that month in UTC. */
function parseMonthKey(key: string): Date {
  const [year, month] = key.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return new Date();
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Current UTC calendar month key, `YYYY-MM`. Aligned with the backend's
 *  `strftime('%Y-%m', completed_at)` so the fallback bucket does not
 *  drift into the next month on days near midnight UTC. */
function currentUtcMonthKey(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

/** Start of the current UTC calendar month. */
function startOfUtcMonth(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0)
  );
}
