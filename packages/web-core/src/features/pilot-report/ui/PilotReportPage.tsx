import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, Download, RotateCcw } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { cn } from '@/shared/lib/utils';
import {
  usePilotReport,
  type PilotReportMergedPr,
  type PilotReportTask,
} from '../model/usePilotReport';
import {
  computePilotReportMetrics,
  formatFte,
  formatHours,
} from '../model/pilotReportMetrics';
import {
  buildPilotReportCsv,
  buildPilotReportFilename,
  downloadCsv,
} from '../model/pilotReportCsv';
import {
  CURRENCY_OPTIONS,
  FALLBACK_CURRENCY,
  FALLBACK_HOURLY_RATE,
  FALLBACK_HOURS_PER_FTE_MONTH,
  FALLBACK_HOURS_PER_TICKET,
  MAX_HOURLY_RATE,
  MAX_HOURS_PER_FTE_MONTH,
  MAX_HOURS_PER_TICKET,
  MIN_HOURLY_RATE,
  MIN_HOURS_PER_FTE_MONTH,
  MIN_HOURS_PER_TICKET,
  usePilotReportSettingsStore,
} from '../model/usePilotReportSettingsStore';
import type { ReportCurrency } from '../model/usePilotReportSettingsStore';
import './pilot-report-print.css';

const PRESET_DAYS = [7, 30, 60, 90] as const;
type PresetWindow = (typeof PRESET_DAYS)[number];

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fromDateInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeWindow(from: Date, to: Date): { start: Date; end: Date } {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const endExclusive = new Date(to);
  endExclusive.setHours(0, 0, 0, 0);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { start, end: endExclusive };
}

export function PilotReportPage() {
  const { t, i18n } = useTranslation('common');
  usePageTitle(t('pilotReport.title'));

  const { config } = useUserSystem();

  // Server config is the source of truth for pricing assumptions. Fall back
  // to the constants only while it's still loading — those must not sneak
  // into a report a CTO will see.
  const configHoursPerTicket =
    config?.default_hours_saved_per_task ?? FALLBACK_HOURS_PER_TICKET;
  const configHoursPerFteMonth =
    config?.default_hours_per_fte_month ?? FALLBACK_HOURS_PER_FTE_MONTH;
  const configHourlyRate = config?.default_hourly_rate ?? FALLBACK_HOURLY_RATE;
  const configCurrency = normalizeCurrency(
    config?.default_currency,
    FALLBACK_CURRENCY
  );

  const {
    hoursPerTicketOverride,
    hoursPerFteMonthOverride,
    hourlyRateOverride,
    currencyOverride,
    setHoursPerTicketOverride,
    setHoursPerFteMonthOverride,
    setHourlyRateOverride,
    setCurrencyOverride,
    resetAll,
  } = usePilotReportSettingsStore();

  const hoursPerTicket = hoursPerTicketOverride ?? configHoursPerTicket;
  const hoursPerFteMonth = hoursPerFteMonthOverride ?? configHoursPerFteMonth;
  const hourlyRate = hourlyRateOverride ?? configHourlyRate;
  const currency: ReportCurrency = currencyOverride ?? configCurrency;

  const hasAnyOverride =
    hoursPerTicketOverride !== null ||
    hoursPerFteMonthOverride !== null ||
    hourlyRateOverride !== null ||
    currencyOverride !== null;

  const [fromInput, setFromInput] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return toDateInputValue(d);
  });
  const [toInput, setToInput] = useState(() => toDateInputValue(new Date()));

  const parsedFrom = useMemo(() => fromDateInputValue(fromInput), [fromInput]);
  const parsedTo = useMemo(() => fromDateInputValue(toInput), [toInput]);

  const { windowStart, windowEnd } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fallbackFrom = new Date(today);
    fallbackFrom.setDate(fallbackFrom.getDate() - 29);
    const from = parsedFrom ?? fallbackFrom;
    const to = parsedTo ?? today;
    const [lo, hi] = from > to ? [to, from] : [from, to];
    const norm = normalizeWindow(lo, hi);
    return { windowStart: norm.start, windowEnd: norm.end };
  }, [parsedFrom, parsedTo]);

  const applyPreset = useCallback((days: PresetWindow) => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    setFromInput(toDateInputValue(start));
    setToInput(toDateInputValue(today));
  }, []);

  const isPresetActive = useCallback(
    (days: PresetWindow) => {
      const ms = windowEnd.getTime() - windowStart.getTime();
      const daysDiff = Math.round(ms / (24 * 60 * 60 * 1000));
      if (daysDiff !== days) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      today.setDate(today.getDate() + 1);
      return windowEnd.getTime() === today.getTime();
    },
    [windowEnd, windowStart]
  );

  const { data, isLoading, error } = usePilotReport(windowStart, windowEnd);

  const metrics = useMemo(
    () =>
      computePilotReportMetrics(
        data,
        {
          hoursPerTicket,
          hoursPerFteMonth,
          hourlyRate,
        },
        windowStart,
        windowEnd
      ),
    [data, hoursPerTicket, hoursPerFteMonth, hourlyRate, windowStart, windowEnd]
  );

  const inclusiveEnd = useMemo(() => {
    const d = new Date(windowEnd);
    d.setDate(d.getDate() - 1);
    return d;
  }, [windowEnd]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language]
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

  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  );

  const rangeLabel = `${dateFormatter.format(windowStart)} → ${dateFormatter.format(inclusiveEnd)}`;

  const handleExportCsv = useCallback(() => {
    const filename = buildPilotReportFilename(windowStart, inclusiveEnd);
    const csv = buildPilotReportCsv(data);
    downloadCsv(filename, csv);
  }, [data, windowStart, inclusiveEnd]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <PageHeader
        title={t('pilotReport.title')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={handleExportCsv}
              disabled={
                data.completed_tasks.length === 0 &&
                data.merged_prs.length === 0
              }
            >
              <Download size={16} strokeWidth={1.75} />
              {t('pilotReport.actions.exportCsv')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={handlePrint}
            >
              <Printer size={16} strokeWidth={1.75} />
              {t('pilotReport.actions.print')}
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-container-padding py-5">
        <article className="pilot-report mx-auto flex w-full max-w-[1024px] flex-col gap-4">
          <header className="flex flex-col gap-2 print:gap-1">
            <p className="text-sm text-low print:text-xs">
              {t('pilotReport.subtitle')}
            </p>
            <h2 className="font-sans text-lg font-semibold text-high print:text-base">
              {t('pilotReport.rangeHeading', { range: rangeLabel })}
            </h2>
          </header>

          <RangeControls
            fromValue={fromInput}
            toValue={toInput}
            onFromChange={setFromInput}
            onToChange={setToInput}
            activePreset={PRESET_DAYS.find((d) => isPresetActive(d)) ?? null}
            onPreset={applyPreset}
          />

          {error ? (
            <div className="rounded-md border border-error/40 bg-error/5 px-3 py-2 text-sm text-error print:hidden">
              {t('pilotReport.loadError')}
            </div>
          ) : null}

          <KpiGrid
            metrics={metrics}
            currencyFormatter={currencyFormatter}
            numberFormatter={numberFormatter}
            isLoading={isLoading}
          />

          <AssumptionsRow
            hoursPerTicket={hoursPerTicket}
            hoursPerFteMonth={hoursPerFteMonth}
            hourlyRate={hourlyRate}
            currency={currency}
            configHoursPerTicket={configHoursPerTicket}
            configHoursPerFteMonth={configHoursPerFteMonth}
            configHourlyRate={configHourlyRate}
            configCurrency={configCurrency}
            hasAnyOverride={hasAnyOverride}
            onHoursPerTicketChange={setHoursPerTicketOverride}
            onHoursPerFteMonthChange={setHoursPerFteMonthOverride}
            onHourlyRateChange={setHourlyRateOverride}
            onCurrencyChange={setCurrencyOverride}
            onResetAll={resetAll}
          />

          <TasksTable
            tasks={data.completed_tasks}
            isLoading={isLoading}
            dateFormatter={dateFormatter}
          />

          <PrsTable
            prs={data.merged_prs}
            isLoading={isLoading}
            dateFormatter={dateFormatter}
          />

          <footer className="hidden text-xs text-low print:block">
            {t('pilotReport.printFooter', {
              generatedAt: new Date().toLocaleString(i18n.language),
            })}
          </footer>
        </article>
      </div>
    </div>
  );
}

function RangeControls({
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  activePreset,
  onPreset,
}: {
  fromValue: string;
  toValue: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  activePreset: PresetWindow | null;
  onPreset: (days: PresetWindow) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3 print:hidden">
      <label className="flex flex-col gap-1 text-xs text-low">
        {t('pilotReport.dateRange.from')}
        <input
          type="date"
          value={fromValue}
          onChange={(event) => onFromChange(event.target.value)}
          className="h-8 rounded border border-border bg-md-background px-2 text-sm text-high"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-low">
        {t('pilotReport.dateRange.to')}
        <input
          type="date"
          value={toValue}
          onChange={(event) => onToChange(event.target.value)}
          className="h-8 rounded border border-border bg-md-background px-2 text-sm text-high"
        />
      </label>
      <div
        className="flex gap-1 rounded-full bg-secondary p-0.5"
        role="group"
        aria-label={t('pilotReport.dateRange.presets')}
      >
        {PRESET_DAYS.map((days) => (
          <button
            key={days}
            type="button"
            aria-pressed={days === activePreset}
            onClick={() => onPreset(days)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
              days === activePreset
                ? 'bg-card text-high'
                : 'text-low hover:text-normal'
            )}
          >
            {t('pilotReport.dateRange.presetLabel', { days })}
          </button>
        ))}
      </div>
    </div>
  );
}

function KpiGrid({
  metrics,
  currencyFormatter,
  numberFormatter,
  isLoading,
}: {
  metrics: ReturnType<typeof computePilotReportMetrics>;
  currencyFormatter: Intl.NumberFormat;
  numberFormatter: Intl.NumberFormat;
  isLoading: boolean;
}) {
  const { t } = useTranslation('common');
  // "≥"/"≤" bounds when at least one done task has no cost recorded — the
  // client's actual API bill is at least this much, and the net savings at
  // most this much. Never invent a zero for the missing tasks.
  const costPrefix = metrics.partialCostCoverage ? '≥ ' : '';
  const netPrefix = metrics.partialCostCoverage ? '≤ ' : '';
  const coverageHint = metrics.partialCostCoverage
    ? t('pilotReport.kpi.partialCoverageHint', {
        withCost: metrics.ticketsWithCost,
        total: metrics.ticketsResolved,
      })
    : undefined;
  const items = [
    {
      label: t('pilotReport.kpi.ticketsResolved'),
      value: numberFormatter.format(metrics.ticketsResolved),
      hint:
        metrics.ticketsFailed > 0
          ? t('pilotReport.kpi.ticketsFailedHint', {
              count: metrics.ticketsFailed,
            })
          : undefined,
    },
    {
      label: t('pilotReport.kpi.prsMerged'),
      value: numberFormatter.format(metrics.prsMerged),
    },
    {
      label: t('pilotReport.kpi.hoursSaved'),
      value: formatHours(metrics.hoursSaved),
      unit: t('pilotReport.kpi.hoursUnit'),
    },
    {
      label: t('pilotReport.kpi.fteEquivalent'),
      value: formatFte(metrics.fteEquivalent),
      unit: t('pilotReport.kpi.fteUnit'),
    },
    {
      label: t('pilotReport.kpi.monetaryValue'),
      value: currencyFormatter.format(metrics.monetaryValue),
    },
    {
      label: t('pilotReport.kpi.apiCost'),
      value: `${costPrefix}${currencyFormatter.format(metrics.apiCostUsd)}`,
      hint: coverageHint,
    },
    {
      label: t('pilotReport.kpi.netMonetaryValue'),
      value: `${netPrefix}${currencyFormatter.format(metrics.netMonetaryValue)}`,
      hint: coverageHint,
    },
    {
      label: t('pilotReport.kpi.effectiveRate'),
      value: currencyFormatter.format(metrics.effectiveHourlyRate),
      unit: t('pilotReport.kpi.effectiveRateUnit'),
      hint: coverageHint,
    },
  ];
  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-4 print:gap-2"
      aria-busy={isLoading}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 print:border-black/20 print:bg-white"
        >
          <span className="text-label font-semibold uppercase tracking-wide text-low print:text-[10px]">
            {item.label}
          </span>
          <span className="font-sans text-2xl font-bold text-high tabular-nums print:text-xl">
            {item.value}
            {item.unit && (
              <span className="ml-1 text-sm font-normal text-low print:text-xs">
                {item.unit}
              </span>
            )}
          </span>
          {item.hint && (
            <span className="text-xs text-low print:text-[10px]">
              {item.hint}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function AssumptionsRow({
  hoursPerTicket,
  hoursPerFteMonth,
  hourlyRate,
  currency,
  configHoursPerTicket,
  configHoursPerFteMonth,
  configHourlyRate,
  configCurrency,
  hasAnyOverride,
  onHoursPerTicketChange,
  onHoursPerFteMonthChange,
  onHourlyRateChange,
  onCurrencyChange,
  onResetAll,
}: {
  hoursPerTicket: number;
  hoursPerFteMonth: number;
  hourlyRate: number;
  currency: ReportCurrency;
  configHoursPerTicket: number;
  configHoursPerFteMonth: number;
  configHourlyRate: number;
  configCurrency: ReportCurrency;
  hasAnyOverride: boolean;
  onHoursPerTicketChange: (value: number | null) => void;
  onHoursPerFteMonthChange: (value: number | null) => void;
  onHourlyRateChange: (value: number | null) => void;
  onCurrencyChange: (value: ReportCurrency | null) => void;
  onResetAll: () => void;
}) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card/50 p-3 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-low">
          {t('pilotReport.assumptions.title')}
        </span>
        <span className="text-xs text-low">
          {t('pilotReport.assumptions.sourceHint')}
        </span>
        {hasAnyOverride && (
          <button
            type="button"
            onClick={onResetAll}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-md-background px-2 py-1 text-xs font-medium text-normal hover:text-high"
          >
            <RotateCcw size={12} strokeWidth={2} />
            {t('pilotReport.assumptions.resetAll')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <NumberAssumptionField
          label={t('pilotReport.assumptions.hoursPerTicket')}
          value={hoursPerTicket}
          configValue={configHoursPerTicket}
          min={MIN_HOURS_PER_TICKET}
          max={MAX_HOURS_PER_TICKET}
          step={0.5}
          onCommit={onHoursPerTicketChange}
        />
        <NumberAssumptionField
          label={t('pilotReport.assumptions.hoursPerFteMonth')}
          value={hoursPerFteMonth}
          configValue={configHoursPerFteMonth}
          min={MIN_HOURS_PER_FTE_MONTH}
          max={MAX_HOURS_PER_FTE_MONTH}
          step={1}
          onCommit={onHoursPerFteMonthChange}
        />
        <NumberAssumptionField
          label={t('pilotReport.assumptions.hourlyRate')}
          value={hourlyRate}
          configValue={configHourlyRate}
          min={MIN_HOURLY_RATE}
          max={MAX_HOURLY_RATE}
          step={1}
          onCommit={onHourlyRateChange}
        />
        <CurrencyAssumptionField
          label={t('pilotReport.assumptions.currency')}
          value={currency}
          configValue={configCurrency}
          onCommit={onCurrencyChange}
        />
      </div>
    </div>
  );
}

function NumberAssumptionField({
  label,
  value,
  configValue,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  configValue: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number | null) => void;
}) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState(String(value));
  // Track whether the store treats this field as modified — a reset from the
  // "Reset all" button, or the config changing under us, must snap the input
  // back to the config value.
  const isModified = value !== configValue;

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      // Storing "the same as config" as `null` keeps the "modified" indicator
      // honest — a viewer who types back the exact config value stops looking
      // like they've overridden anything.
      if (parsed === configValue) {
        onCommit(null);
        setDraft(String(configValue));
        return;
      }
      onCommit(parsed);
    } else {
      onCommit(null);
      setDraft(String(configValue));
    }
  };

  return (
    <label className="flex flex-col gap-1 text-xs text-low">
      <span className="flex items-center gap-1.5">
        {label}
        {isModified && (
          <span
            title={t('pilotReport.assumptions.modifiedHint')}
            className="rounded-full bg-brand-container/50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-on-surface"
          >
            {t('pilotReport.assumptions.modifiedBadge')}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          className={cn(
            'h-8 w-24 rounded border bg-md-background px-2 text-right text-sm text-high tabular-nums',
            isModified ? 'border-brand-on-surface' : 'border-border'
          )}
        />
        {isModified && (
          <button
            type="button"
            onClick={() => onCommit(null)}
            title={t('pilotReport.assumptions.resetField', {
              value: configValue,
            })}
            aria-label={t('pilotReport.assumptions.resetField', {
              value: configValue,
            })}
            className="inline-flex h-8 w-6 items-center justify-center rounded text-low hover:text-normal"
          >
            <RotateCcw size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </label>
  );
}

function CurrencyAssumptionField({
  label,
  value,
  configValue,
  onCommit,
}: {
  label: string;
  value: ReportCurrency;
  configValue: ReportCurrency;
  onCommit: (value: ReportCurrency | null) => void;
}) {
  const { t } = useTranslation('common');
  const isModified = value !== configValue;
  return (
    <label className="flex flex-col gap-1 text-xs text-low">
      <span className="flex items-center gap-1.5">
        {label}
        {isModified && (
          <span
            title={t('pilotReport.assumptions.modifiedHint')}
            className="rounded-full bg-brand-container/50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand-on-surface"
          >
            {t('pilotReport.assumptions.modifiedBadge')}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1">
        <select
          value={value}
          onChange={(event) => {
            const next = event.target.value as ReportCurrency;
            // Same rule as the numeric fields: matching the config value
            // stores `null` so the "modified" badge stays accurate.
            onCommit(next === configValue ? null : next);
          }}
          className={cn(
            'h-8 rounded border bg-md-background px-2 text-sm text-high',
            isModified ? 'border-brand-on-surface' : 'border-border'
          )}
        >
          {CURRENCY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {isModified && (
          <button
            type="button"
            onClick={() => onCommit(null)}
            title={t('pilotReport.assumptions.resetField', {
              value: configValue,
            })}
            aria-label={t('pilotReport.assumptions.resetField', {
              value: configValue,
            })}
            className="inline-flex h-8 w-6 items-center justify-center rounded text-low hover:text-normal"
          >
            <RotateCcw size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </label>
  );
}

function normalizeCurrency(
  raw: string | undefined | null,
  fallback: ReportCurrency
): ReportCurrency {
  if (raw && (CURRENCY_OPTIONS as readonly string[]).includes(raw)) {
    return raw as ReportCurrency;
  }
  return fallback;
}

function TasksTable({
  tasks,
  isLoading,
  dateFormatter,
}: {
  tasks: PilotReportTask[];
  isLoading: boolean;
  dateFormatter: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('common');
  if (isLoading && tasks.length === 0) {
    return (
      <SectionShell title={t('pilotReport.tasksSection.title')}>
        <p className="px-3 py-4 text-sm text-low">{t('pilotReport.loading')}</p>
      </SectionShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <SectionShell title={t('pilotReport.tasksSection.title')}>
        <p className="px-3 py-4 text-sm text-low">
          {t('pilotReport.tasksSection.empty')}
        </p>
      </SectionShell>
    );
  }
  return (
    <SectionShell
      title={t('pilotReport.tasksSection.title')}
      count={tasks.length}
    >
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-label font-semibold uppercase tracking-wide text-low">
          <tr>
            <th className="px-3 py-2 font-semibold">
              {t('pilotReport.tasksSection.status')}
            </th>
            <th className="px-3 py-2 font-semibold">
              {t('pilotReport.tasksSection.titleColumn')}
            </th>
            <th className="px-3 py-2 font-semibold">
              {t('pilotReport.tasksSection.issue')}
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              {t('pilotReport.tasksSection.completedAt')}
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={`${task.worker_id}-${task.completed_at}-${task.title}`}
              className="border-b border-border last:border-b-0"
            >
              <td className="px-3 py-1.5 align-top">
                <StatusBadge status={task.status} />
              </td>
              <td className="px-3 py-1.5 align-top text-normal">
                {task.title}
              </td>
              <td className="px-3 py-1.5 align-top tabular-nums text-low">
                {task.issue_number !== null ? `#${task.issue_number}` : '—'}
              </td>
              <td className="px-3 py-1.5 text-right align-top tabular-nums text-low">
                {formatSqliteDate(task.completed_at, dateFormatter)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionShell>
  );
}

function PrsTable({
  prs,
  isLoading,
  dateFormatter,
}: {
  prs: PilotReportMergedPr[];
  isLoading: boolean;
  dateFormatter: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('common');
  if (isLoading && prs.length === 0) {
    return (
      <SectionShell title={t('pilotReport.prsSection.title')}>
        <p className="px-3 py-4 text-sm text-low">{t('pilotReport.loading')}</p>
      </SectionShell>
    );
  }
  if (prs.length === 0) {
    return (
      <SectionShell title={t('pilotReport.prsSection.title')}>
        <p className="px-3 py-4 text-sm text-low">
          {t('pilotReport.prsSection.empty')}
        </p>
      </SectionShell>
    );
  }
  return (
    <SectionShell title={t('pilotReport.prsSection.title')} count={prs.length}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-label font-semibold uppercase tracking-wide text-low">
          <tr>
            <th className="px-3 py-2 font-semibold">
              {t('pilotReport.prsSection.number')}
            </th>
            <th className="px-3 py-2 font-semibold">
              {t('pilotReport.prsSection.targetBranch')}
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              {t('pilotReport.prsSection.mergedAt')}
            </th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr
              key={pr.pr_url}
              className="border-b border-border last:border-b-0"
            >
              <td className="px-3 py-1.5 align-top tabular-nums">
                <a
                  href={pr.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-on-surface underline-offset-4 hover:underline"
                >
                  #{pr.pr_number}
                </a>
              </td>
              <td className="px-3 py-1.5 align-top text-normal">
                {pr.target_branch_name}
              </td>
              <td className="px-3 py-1.5 text-right align-top tabular-nums text-low">
                {formatSqliteDate(pr.merged_at, dateFormatter)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionShell>
  );
}

function SectionShell({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-lg border border-border bg-card print:border-black/20 print:bg-white"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border px-3 font-sans text-label font-semibold uppercase tracking-wide text-low">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-secondary px-2 py-px text-xs font-semibold text-normal tabular-nums">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('common');
  const isDone = status === 'done';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        isDone ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isDone ? 'bg-success' : 'bg-error'
        )}
      />
      {isDone ? t('pilotReport.status.done') : t('pilotReport.status.failed')}
    </span>
  );
}

function formatSqliteDate(raw: string, formatter: Intl.DateTimeFormat): string {
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return raw;
  return formatter.format(date);
}
