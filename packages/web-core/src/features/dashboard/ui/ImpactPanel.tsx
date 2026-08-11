import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import {
  bucketResolvedTasksByDay,
  formatManHours,
  type ResolvedTaskDay,
} from '@/features/dashboard/model/dashboardMetrics';
import {
  IMPACT_WINDOWS,
  useResolvedTasks,
} from '@/features/dashboard/model/useResolvedTasks';
import {
  DEFAULT_HOURS_PER_ISSUE,
  MAX_HOURS_PER_ISSUE,
  MIN_HOURS_PER_ISSUE,
  useImpactSettingsStore,
} from '@/features/dashboard/model/useImpactSettingsStore';
import { Panel, PanelEmpty } from './parts/primitives';

const CHART_HEIGHT = 180;
const PAD = { top: 14, right: 10, bottom: 22, left: 30 };
/** Below this many pixels the geometry stops being legible; scroll instead. */
const MIN_CHART_WIDTH = 320;
/** Past this many points the individual dots turn into noise. */
const DOTS_MAX_POINTS = 45;
/** Roughly how many date labels to fit on the x-axis. */
const X_TICK_TARGET = 6;
/** Tasks named in the tooltip before collapsing into "+N more". */
const TOOLTIP_TASK_LIMIT = 3;

/** Round the y-axis up to something divisible by 4, so gridlines stay integers. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  return Math.ceil(max / 4) * 4;
}

/** Track an element's width so the chart can use real pixel coordinates. */
function useElementWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * Worker tasks resolved per day, with the equivalent man-hours behind each
 * point. Counts the same `status = 'done'` population as the value-generated
 * panel, so the two surfaces never disagree on how much work was delivered.
 *
 * Self-contained: owns its query and its settings, so `useDashboardData` stays
 * focused on live worker state.
 */
export function ImpactPanel() {
  const { t, i18n } = useTranslation('common');

  const { config } = useUserSystem();
  const windowDays = useImpactSettingsStore((s) => s.windowDays);
  const setWindowDays = useImpactSettingsStore((s) => s.setWindowDays);
  const hoursPerIssueOverride = useImpactSettingsStore(
    (s) => s.hoursPerIssueOverride
  );
  const setHoursPerIssueOverride = useImpactSettingsStore(
    (s) => s.setHoursPerIssueOverride
  );

  // Same source of truth as the value-generated panel and pilot report:
  // `Config.default_hours_saved_per_task`. A local override still wins
  // because this panel is a viewer scratchpad, but the resting default
  // now matches the pricing figure the rest of the app uses.
  const configHoursPerIssue =
    config?.default_hours_saved_per_task ?? DEFAULT_HOURS_PER_ISSUE;
  const hoursPerIssue = hoursPerIssueOverride ?? configHoursPerIssue;

  const { tasks, isLoading } = useResolvedTasks(windowDays);

  const [hovered, setHovered] = useState<number | null>(null);
  const [factorDraft, setFactorDraft] = useState(() => String(hoursPerIssue));

  const buckets = useMemo(
    () => bucketResolvedTasksByDay(tasks, windowDays),
    [tasks, windowDays]
  );
  const totalTasks = useMemo(
    () => buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    [buckets]
  );

  const tickFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language]
  );
  const dayFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language]
  );

  // Re-hydrate the draft whenever the effective value changes underneath us
  // (config load, user hit "reset", or another tab wrote to localStorage).
  // Skipped while the user is mid-edit so their typing wins.
  useEffect(() => {
    setFactorDraft((draft) =>
      Number.parseFloat(draft) === hoursPerIssue ? draft : String(hoursPerIssue)
    );
  }, [hoursPerIssue]);

  const commitFactor = (raw: string) => {
    setFactorDraft(raw);
    const parsed = Number.parseFloat(raw);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_HOURS_PER_ISSUE &&
      parsed <= MAX_HOURS_PER_ISSUE
    ) {
      // Store `null` when the viewer types the exact config value back —
      // that keeps the "modified from config" story honest across surfaces.
      setHoursPerIssueOverride(parsed === configHoursPerIssue ? null : parsed);
    }
  };

  const normalizeFactor = () => {
    const parsed = Number.parseFloat(factorDraft);
    const next = Number.isFinite(parsed)
      ? Math.min(MAX_HOURS_PER_ISSUE, Math.max(MIN_HOURS_PER_ISSUE, parsed))
      : configHoursPerIssue;
    setHoursPerIssueOverride(next === configHoursPerIssue ? null : next);
    setFactorDraft(String(next));
  };

  const totalHours = formatManHours(totalTasks * hoursPerIssue);

  // `Panel` already right-aligns whatever it gets as `aside`.
  const head = (
    <span className="flex items-center gap-2.5">
      <span
        className="flex gap-0.5 rounded-full bg-secondary p-0.5"
        role="group"
        aria-label={t('dashboard.impact.windowLabel')}
      >
        {IMPACT_WINDOWS.map((days) => (
          <button
            key={days}
            type="button"
            aria-pressed={days === windowDays}
            onClick={() => {
              setWindowDays(days);
              setHovered(null);
            }}
            className={cn(
              'rounded-full px-2 py-px text-xs font-semibold normal-case tracking-normal tabular-nums',
              days === windowDays
                ? 'bg-card text-high'
                : 'text-low hover:text-normal'
            )}
          >
            {t('dashboard.impact.windowDays', { days })}
          </button>
        ))}
      </span>
      <label className="flex items-center gap-1.5 text-xs font-normal normal-case tracking-normal text-low">
        <input
          type="number"
          min={MIN_HOURS_PER_ISSUE}
          max={MAX_HOURS_PER_ISSUE}
          step={0.5}
          value={factorDraft}
          aria-label={t('dashboard.impact.hoursPerTaskLabel')}
          onChange={(event) => commitFactor(event.target.value)}
          onBlur={normalizeFactor}
          className="w-12 rounded border border-border bg-md-background px-1.5 py-px text-right text-xs text-high tabular-nums"
        />
        {t('dashboard.impact.hoursPerTask')}
      </label>
    </span>
  );

  return (
    <Panel title={t('dashboard.impact.title')} aside={head}>
      <div className="flex flex-col gap-2.5 p-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-sans text-2xl font-bold leading-tight tracking-tight text-high tabular-nums">
            {t('dashboard.impact.hoursSaved', { hours: totalHours })}
          </span>
          <span className="text-sm text-low">
            {t('dashboard.impact.summary', {
              count: totalTasks,
              days: windowDays,
            })}
          </span>
        </div>

        {totalTasks === 0 ? (
          <PanelEmpty>
            {isLoading
              ? t('dashboard.impact.loading')
              : t('dashboard.impact.empty')}
          </PanelEmpty>
        ) : (
          <ImpactChart
            buckets={buckets}
            hovered={hovered}
            onHover={setHovered}
            hoursPerIssue={hoursPerIssue}
            totalTasks={totalTasks}
            totalHours={totalHours}
            windowDays={windowDays}
            tickFormatter={tickFormatter}
            dayFormatter={dayFormatter}
          />
        )}
      </div>
    </Panel>
  );
}

function ImpactChart({
  buckets,
  hovered,
  onHover,
  hoursPerIssue,
  totalTasks,
  totalHours,
  windowDays,
  tickFormatter,
  dayFormatter,
}: {
  buckets: ResolvedTaskDay[];
  hovered: number | null;
  onHover: (index: number | null) => void;
  hoursPerIssue: number;
  totalTasks: number;
  totalHours: string;
  windowDays: number;
  tickFormatter: Intl.DateTimeFormat;
  dayFormatter: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation('common');
  const svgRef = useRef<SVGSVGElement>(null);
  // Measured here rather than in the parent: the ref must be attached by the
  // same component that observes it, otherwise the effect runs while the chart
  // is still unmounted (waiting on data) and never observes anything.
  const containerRef = useRef<HTMLDivElement>(null);
  const measuredWidth = useElementWidth(containerRef);

  const chartWidth = Math.max(measuredWidth, MIN_CHART_WIDTH);
  const innerWidth = chartWidth - PAD.left - PAD.right;
  const innerHeight = CHART_HEIGHT - PAD.top - PAD.bottom;
  const count = buckets.length;
  const step = count > 1 ? innerWidth / (count - 1) : 0;
  const maxCount = niceMax(Math.max(...buckets.map((b) => b.count)));
  const baseline = PAD.top + innerHeight;

  const x = (index: number) => PAD.left + index * step;
  const y = (value: number) =>
    PAD.top + innerHeight - (value / maxCount) * innerHeight;

  const points = buckets.map((b, i) => `${x(i)},${y(b.count)}`).join(' ');
  const areaPath = `M ${x(0)},${baseline} L ${buckets
    .map((b, i) => `${x(i)},${y(b.count)}`)
    .join(' L ')} L ${x(count - 1)},${baseline} Z`;

  const tickEvery = Math.max(1, Math.round(count / X_TICK_TARGET));
  const gridValues = [0, 1, 2, 3, 4].map((n) => (maxCount / 4) * n);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || step <= 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const localX = ((event.clientX - rect.left) * chartWidth) / rect.width;
    const index = Math.round((localX - PAD.left) / step);
    onHover(Math.min(count - 1, Math.max(0, index)));
  };

  // `?? null` guards against a hovered index left over from a wider window.
  const active = hovered === null ? null : (buckets[hovered] ?? null);
  const activeX = hovered === null ? 0 : x(hovered);
  const flipTooltip = activeX > chartWidth * 0.6;

  return (
    <div ref={containerRef} className="relative">
      <svg
        ref={svgRef}
        width={chartWidth}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
        className="block w-full"
        role="img"
        aria-label={t('dashboard.impact.chartLabel', {
          days: windowDays,
          total: totalTasks,
          hours: totalHours,
        })}
        onMouseMove={handleMove}
        onMouseLeave={() => onHover(null)}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={PAD.left}
              y1={y(value)}
              x2={chartWidth - PAD.right}
              y2={y(value)}
              className="stroke-md-outline-variant/60"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 7}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-low text-[10px] tabular-nums"
            >
              {value}
            </text>
          </g>
        ))}

        <path d={areaPath} className="fill-brand-on-surface/10" />
        <polyline
          points={points}
          className="fill-none stroke-brand-on-surface"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {buckets.map((bucket, index) => {
          if (index % tickEvery !== 0 && index !== count - 1) return null;
          return (
            <text
              key={bucket.dayKey}
              x={x(index)}
              y={CHART_HEIGHT - 6}
              textAnchor="middle"
              className="fill-low text-[10px]"
            >
              {tickFormatter.format(bucket.date)}
            </text>
          );
        })}

        {hovered !== null && (
          <line
            x1={x(hovered)}
            y1={PAD.top}
            x2={x(hovered)}
            y2={baseline}
            className="stroke-brand-on-surface/40"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

        {buckets.map((bucket, index) => {
          const isActive = index === hovered;
          if (!isActive && count > DOTS_MAX_POINTS) return null;
          return (
            <circle
              key={bucket.dayKey}
              cx={x(index)}
              cy={y(bucket.count)}
              r={isActive ? 4 : 2.5}
              className={
                isActive
                  ? 'fill-brand-on-surface stroke-card'
                  : 'fill-card stroke-brand-on-surface'
              }
              strokeWidth={isActive ? 2 : 1.5}
            />
          );
        })}
      </svg>

      {active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[11rem] max-w-[15rem] rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-normal shadow-overlay"
          style={{
            left: activeX + (flipTooltip ? -12 : 12),
            top: PAD.top,
            transform: flipTooltip ? 'translateX(-100%)' : undefined,
          }}
        >
          <div className="font-sans text-label font-semibold uppercase tracking-wide text-low">
            {dayFormatter.format(active.date)}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-high">
            {t('dashboard.impact.tooltipTasks', { count: active.count })}
          </div>
          {active.count > 0 && (
            <>
              <div className="mt-1 border-t border-border pt-1 tabular-nums">
                {t('dashboard.impact.tooltipHours', {
                  tasks: active.count,
                  factor: formatManHours(hoursPerIssue),
                  hours: formatManHours(active.count * hoursPerIssue),
                })}
              </div>
              <ul className="mt-1 space-y-0.5">
                {active.tasks.slice(0, TOOLTIP_TASK_LIMIT).map((task, index) => (
                  <li
                    key={`${task.issueNumber ?? 'task'}-${index}`}
                    className="truncate text-[11px]"
                  >
                    {task.issueNumber !== null && (
                      <>
                        <span className="text-normal tabular-nums">
                          #{task.issueNumber}
                        </span>{' '}
                      </>
                    )}
                    <span className="text-low">{task.title}</span>
                  </li>
                ))}
                {active.tasks.length > TOOLTIP_TASK_LIMIT && (
                  <li className="text-[11px] text-low">
                    {t('dashboard.impact.moreTasks', {
                      extra: active.tasks.length - TOOLTIP_TASK_LIMIT,
                    })}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}

      <ul className="sr-only">
        {buckets.map((bucket) => (
          <li key={bucket.dayKey}>
            {dayFormatter.format(bucket.date)}:{' '}
            {t('dashboard.impact.tooltipTasks', { count: bucket.count })}
          </li>
        ))}
      </ul>
    </div>
  );
}
