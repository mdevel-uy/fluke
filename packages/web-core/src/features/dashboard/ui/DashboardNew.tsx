import { useTranslation } from 'react-i18next';
import type { RepoOverview } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { DashboardData } from '@/features/dashboard/model/useDashboardData';
import {
  agentLabel,
  awaitingMergeTickets,
  formatDurationSince,
  formatManHours,
  parseSqliteUtc,
  ticketHours,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import { useAttentionItems } from './AttentionPanel';
import { CELL_CLASS, repoState } from './ReposPanel';
import { SectionTitle } from './parts/primitives';

const DAY_MS = 24 * 60 * 60 * 1000;
const usd0 = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const CHIP_DOT: Record<string, string> = {
  question: 'bg-warning',
  approval: 'bg-warning',
  no_progress: 'bg-warning',
  review_cap: 'bg-merged',
  credential: 'bg-error',
  failed: 'bg-error',
  conflict: 'bg-error',
  merge: 'bg-success',
};

/** The visual dashboard: what needs you, key numbers, one card per project,
 * a two-week activity strip, who works now and where the money went. Lists
 * stay behind a click (each card and chip opens its detail). */
export function DashboardNew({
  data,
  hoursPerTicket,
}: {
  data: DashboardData;
  hoursPerTicket: number;
}) {
  const { t } = useTranslation('common');
  const repos = data.overview!.repos;
  return (
    <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-4">
      <NeedsYou data={data} />
      <Numbers data={data} hoursPerTicket={hoursPerTicket} />
      <section className="flex flex-col gap-2">
        <SectionTitle>{t('dashboard.v2.projects')}</SectionTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {repos.map((repo) => (
            <ProjectCard key={repo.repo_id} repo={repo} />
          ))}
        </div>
      </section>
      <Pulse repos={repos} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <RunningNow data={data} />
        <Spend data={data} />
      </div>
    </div>
  );
}

function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card p-4', className)}
    >
      {children}
    </div>
  );
}

function NeedsYou({ data }: { data: DashboardData }) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const { items } = useAttentionItems(data);
  const groups = new Map<string, typeof items>();
  for (const item of items)
    groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
  const merge = awaitingMergeTickets(data.tickets);
  if (groups.size === 0 && merge.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs text-low">
        {t('dashboard.v2.needsYou')}
      </span>
      {[...groups].map(([kind, group]) => (
        <Chip
          key={kind}
          dot={CHIP_DOT[kind]}
          label={t(`dashboard.v2.kind.${kind}`, { count: group.length })}
          onClick={group[0].onAction}
        />
      ))}
      {merge.length > 0 && (
        <Chip
          dot={CHIP_DOT.merge}
          label={t('dashboard.v2.kind.merge', { count: merge.length })}
          onClick={() => {
            const ws = merge[0].merge_gate?.workspace_id;
            if (ws) nav.goToWorkspace(ws);
          }}
        />
      )}
    </div>
  );
}

function Chip({
  dot,
  label,
  onClick,
}: {
  dot?: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-normal hover:bg-secondary/60"
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', dot ?? 'bg-md-outline')}
      />
      {label}
    </button>
  );
}

function Numbers({
  data,
  hoursPerTicket,
}: {
  data: DashboardData;
  hoursPerTicket: number;
}) {
  const { t } = useTranslation('common');
  const overview = data.overview!;
  const resolvedSince = (days: number) =>
    data.tickets.filter(
      (tk) =>
        tk.resolved_at &&
        Date.now() - parseSqliteUtc(tk.resolved_at).getTime() < days * DAY_MS
    );
  const cost30 =
    data.providers?.providers.reduce((sum, p) => sum + p.cost_30d, 0) ??
    overview.repos.reduce((sum, r) => sum + r.cost_30d, 0);
  const hours30 = resolvedSince(30).reduce(
    (sum, tk) => sum + ticketHours(tk, hoursPerTicket),
    0
  );
  // Daily agent hours across every repo, for the spend trend.
  const trend = overview.repos.reduce<number[]>(
    (acc, r) => r.activity.map((h, i) => (acc[i] ?? 0) + h),
    []
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Stat label={t('dashboard.v2.agentsNow')}>
        {overview.slots_used}
        {overview.slots_limit > 0 && (
          <span className="text-sm text-low"> / {overview.slots_limit}</span>
        )}
      </Stat>
      <Stat label={t('dashboard.v2.resolved7d')} tone="text-success">
        {resolvedSince(7).length}
      </Stat>
      <Stat label={t('dashboard.v2.queued')}>{overview.queued.length}</Stat>
      <Stat label={t('dashboard.v2.spent30d')} extra={<Spark values={trend} />}>
        {usd0.format(cost30)}
      </Stat>
      <Stat label={t('dashboard.v2.saved30d')}>
        ≈ {formatManHours(hours30)}h
      </Stat>
    </div>
  );
}

function Stat({
  label,
  tone,
  extra,
  children,
}: {
  label: string;
  tone?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-3">
      <div className="text-xs text-low">{label}</div>
      <div
        className={cn(
          'font-mono text-xl font-semibold tabular-nums text-high',
          tone
        )}
      >
        {children}
      </div>
      {extra}
    </Card>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 0);
  if (max === 0) return null;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${15 - (v / max) * 13}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 16"
      className="mt-1 h-3.5 w-full text-brand-on-surface"
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
    </svg>
  );
}

function Ring({ pct, tone }: { pct: number; tone: string }) {
  const r = 26;
  const len = 2 * Math.PI * r;
  return (
    <svg width={62} height={62} viewBox="0 0 62 62" className="shrink-0">
      <circle
        cx={31}
        cy={31}
        r={r}
        fill="none"
        strokeWidth={6}
        className="text-md-outline-variant/60"
        stroke="currentColor"
      />
      {pct > 0 && (
        <circle
          cx={31}
          cy={31}
          r={r}
          fill="none"
          strokeWidth={6}
          strokeLinecap="round"
          stroke="currentColor"
          className={tone}
          strokeDasharray={`${(pct / 100) * len} ${len}`}
          transform="rotate(-90 31 31)"
        />
      )}
      <text
        x={31}
        y={35}
        textAnchor="middle"
        className="fill-current font-mono text-[12px] text-high"
      >
        {pct}%
      </text>
    </svg>
  );
}

function ProjectCard({ repo }: { repo: RepoOverview }) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const ms = repo.milestone;
  const state = repoState(repo);
  const pct =
    ms && ms.issues_total > 0
      ? Math.round((ms.issues_closed / ms.issues_total) * 100)
      : 0;
  const idle = state === 'idle' && repo.activity.every((h) => h === 0);
  const waveIdx = ms
    ? Math.max(
        0,
        ms.waves.findIndex((w) => w.wave === ms.current_wave)
      )
    : 0;
  const cells = ms?.waves[waveIdx]?.cells ?? [];
  return (
    <button
      type="button"
      onClick={() => nav.goToIssues(repo.repo_id)}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-secondary/40',
        state === 'running' ? 'border-brand/60' : 'border-border',
        idle && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-3">
        <Ring
          pct={pct}
          tone={pct >= 100 ? 'text-success' : 'text-brand-on-surface'}
        />
        <div className="min-w-0">
          <div className="truncate font-semibold text-high">{repo.name}</div>
          <div className="truncate text-xs text-low">
            {ms
              ? `${ms.name} · ${t('dashboard.v2.waveOf', { wave: waveIdx + 1, total: ms.waves.length })}`
              : repo.last_activity
                ? t('dashboard.v2.quietFor', {
                    time: formatDurationSince(repo.last_activity),
                  })
                : t('dashboard.repos.noMilestone')}
          </div>
          {cells.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {cells.map((c) => (
                <i
                  key={c.number}
                  title={`#${c.number}`}
                  className={cn(
                    'block h-1.5 w-1.5 rounded-full',
                    CELL_CLASS[c.state] ?? CELL_CLASS.pending,
                    c.state === 'active' &&
                      'animate-pulse motion-reduce:animate-none'
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-low">
        <span className="flex gap-3">
          {repo.running > 0 && (
            <span className="text-brand-on-surface">
              {t('dashboard.v2.working', { count: repo.running })}
            </span>
          )}
          {repo.open_prs > 0 && (
            <span className="text-warning">
              {t('dashboard.v2.openPrs', { count: repo.open_prs })}
            </span>
          )}
          {repo.blocked > 0 && (
            <span className="text-error">
              {t('dashboard.v2.blocked', { count: repo.blocked })}
            </span>
          )}
        </span>
        <span className="font-mono">{usd0.format(repo.cost_30d)}</span>
      </div>
    </button>
  );
}

function Pulse({ repos }: { repos: RepoOverview[] }) {
  const { t } = useTranslation('common');
  const max = Math.max(...repos.flatMap((r) => r.activity), 0);
  if (repos.length === 0) return null;
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between">
        <SectionTitle>{t('dashboard.v2.pulse')}</SectionTitle>
        <span className="text-xs text-low">{t('dashboard.v2.pulseHint')}</span>
      </div>
      <div className="flex flex-col gap-1">
        {repos.map((repo) => (
          <div
            key={repo.repo_id}
            className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3"
          >
            <span className="truncate text-xs text-normal">{repo.name}</span>
            <div
              className="grid gap-[3px]"
              style={{
                gridTemplateColumns: `repeat(${repo.activity.length}, minmax(0, 1fr))`,
              }}
            >
              {repo.activity.map((h, i) => (
                <i
                  key={i}
                  title={t('dashboard.v2.pulseCell', {
                    hours: h.toFixed(1),
                    days: repo.activity.length - 1 - i,
                  })}
                  className={cn(
                    'block h-4 rounded-sm',
                    h > 0 ? 'bg-brand' : 'bg-md-outline-variant/50'
                  )}
                  style={
                    h > 0 && max > 0
                      ? { opacity: 0.25 + 0.75 * (h / max) }
                      : undefined
                  }
                />
              ))}
            </div>
            <span className="text-right text-xs">
              {repo.running > 0 ? (
                <span className="text-brand-on-surface">● {repo.running}</span>
              ) : repo.open_prs > 0 ? (
                <span className="text-warning">{repo.open_prs} PR</span>
              ) : (
                <span className="text-low">—</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RunningNow({ data }: { data: DashboardData }) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const { running, queued, slots_used, slots_limit } = data.overview!;
  return (
    <Card className="lg:col-span-3">
      <div className="mb-3 flex items-baseline justify-between">
        <SectionTitle>{t('dashboard.v2.workingNow')}</SectionTitle>
        <span className="text-xs text-low">
          {slots_limit > 0 ? `${slots_used} / ${slots_limit}` : slots_used}
        </span>
      </div>
      {running.length === 0 ? (
        <p className="text-sm text-low">{t('dashboard.v2.nobodyWorking')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {running.map((r) => {
            const pct =
              r.steps_total > 0 ? (r.steps_done / r.steps_total) * 100 : 50;
            return (
              <button
                key={r.task_id}
                type="button"
                onClick={() =>
                  r.workspace_id && nav.goToWorkspace(r.workspace_id)
                }
                className="flex items-center gap-3 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-semibold uppercase text-brand-on-surface">
                  {r.role.charAt(0)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-high">
                    {r.profile}{' '}
                    <span className="text-xs text-low">
                      · {r.repo_name}
                      {r.issue_number != null && ` #${r.issue_number}`}
                    </span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-md-outline-variant/60">
                    <span
                      className="block h-full animate-pulse bg-brand motion-reduce:animate-none"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                </span>
                <span className="text-xs text-low">
                  {formatDurationSince(r.started_at)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {queued.length > 0 && (
        <p className="mt-3 text-xs text-low">
          {t('dashboard.v2.inQueue', { count: queued.length })}
        </p>
      )}
    </Card>
  );
}

const SLICE_TONES = [
  'text-brand-on-surface',
  'text-success',
  'text-warning',
  'text-merged',
];

function Spend({ data }: { data: DashboardData }) {
  const { t } = useTranslation('common');
  const repos = data
    .overview!.repos.filter((r) => r.cost_30d > 0)
    .sort((a, b) => b.cost_30d - a.cost_30d)
    .slice(0, SLICE_TONES.length);
  const total = repos.reduce((sum, r) => sum + r.cost_30d, 0);
  const r = 32;
  const len = 2 * Math.PI * r;
  let offset = 0;
  const meters = (data.providers?.providers ?? []).flatMap((p) =>
    p.meters.map((m) => ({
      key: `${p.agent}-${m.key}`,
      label: `${agentLabel(p.agent)} · ${t(`dashboard.providers.meter.${m.key}`, { defaultValue: m.key })}`,
      pct: m.used_percent,
    }))
  );
  return (
    <Card className="lg:col-span-2">
      <div className="mb-3 flex items-baseline justify-between">
        <SectionTitle>{t('dashboard.v2.spend')}</SectionTitle>
        <span className="text-xs text-low">30d</span>
      </div>
      <div className="flex items-center gap-4">
        <svg width={84} height={84} viewBox="0 0 84 84" className="shrink-0">
          <circle
            cx={42}
            cy={42}
            r={r}
            fill="none"
            strokeWidth={10}
            stroke="currentColor"
            className="text-md-outline-variant/60"
          />
          {repos.map((repo, i) => {
            const part = (repo.cost_30d / total) * len;
            const el = (
              <circle
                key={repo.repo_id}
                cx={42}
                cy={42}
                r={r}
                fill="none"
                strokeWidth={10}
                stroke="currentColor"
                className={SLICE_TONES[i]}
                strokeDasharray={`${part} ${len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 42 42)"
              />
            );
            offset += part;
            return el;
          })}
          <text
            x={42}
            y={46}
            textAnchor="middle"
            className="fill-current font-mono text-[13px] text-high"
          >
            {usd0.format(total)}
          </text>
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {repos.map((repo, i) => (
            <span
              key={repo.repo_id}
              className="flex justify-between gap-2 text-xs text-low"
            >
              <span className="truncate">
                <span className={SLICE_TONES[i]}>■</span> {repo.name}
              </span>
              <span className="font-mono">
                {usdFormatter.format(repo.cost_30d)}
              </span>
            </span>
          ))}
          {meters.map((m) => (
            <div key={m.key}>
              <div className="text-xs text-low">{m.label}</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-md-outline-variant/60">
                <div
                  className={cn(
                    'h-full',
                    m.pct >= 90
                      ? 'bg-error'
                      : m.pct >= 70
                        ? 'bg-warning'
                        : 'bg-brand'
                  )}
                  style={{ width: `${Math.min(100, m.pct)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
