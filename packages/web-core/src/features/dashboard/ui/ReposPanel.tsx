import { useTranslation } from 'react-i18next';
import type { RepoOverview } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import {
  formatDurationSince,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import { SectionTitle } from './parts/primitives';

const CELL_CLASS: Record<string, string> = {
  done: 'bg-success',
  active: 'bg-brand',
  failed: 'bg-error',
  decision: 'bg-warning',
  pending: 'bg-md-outline-variant',
};

type RepoState = 'running' | 'waiting' | 'paused' | 'idle';

function repoState(repo: RepoOverview): RepoState {
  if (repo.running > 0) return 'running';
  if (repo.milestone?.status === 'waiting' || repo.blocked > 0)
    return 'waiting';
  if (repo.milestone?.status === 'paused') return 'paused';
  return 'idle';
}

const STATE_CLASS: Record<
  RepoState,
  { card: string; text: string; dot: string }
> = {
  running: {
    card: 'border-brand/50',
    text: 'text-brand-on-surface',
    dot: 'bg-brand',
  },
  waiting: {
    card: 'border-warning/50',
    text: 'text-warning',
    dot: 'bg-warning',
  },
  paused: { card: 'border-border', text: 'text-normal', dot: 'bg-md-outline' },
  idle: { card: 'border-border', text: 'text-low', dot: 'bg-md-outline' },
};

/** `decision:12` / `failed:12` / `designer:12` → the issue that stops the run. */
function waitingIssue(reason: string | null): string | null {
  const n = reason?.split(':')[1];
  return n ? `#${n}` : null;
}

function RepoCard({ repo }: { repo: RepoOverview }) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const state = repoState(repo);
  const cls = STATE_CLASS[state];
  const ms = repo.milestone;
  const pct =
    ms && ms.issues_total > 0
      ? Math.round((ms.issues_closed / ms.issues_total) * 100)
      : 0;
  const stoppedBy = waitingIssue(ms?.waiting_reason ?? null);

  return (
    <button
      type="button"
      onClick={() => nav.goToIssues(repo.repo_id)}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-secondary/40',
        cls.card
      )}
    >
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-2 font-mono text-sm font-medium text-high">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cls.dot)} />
          <span className="truncate">{repo.name}</span>
        </span>
        <span
          className={cn(
            'ml-auto rounded-full border border-border px-2 py-px text-xs',
            cls.text
          )}
        >
          {t(`dashboard.repos.state.${state}`)}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-low">
          {ms
            ? t('dashboard.repos.activeMilestone')
            : t('dashboard.repos.noMilestone')}
        </span>
        <span className="text-sm font-semibold text-high">
          {ms ? ms.name : t('dashboard.repos.nothingPlanned')}
        </span>
        <span className="text-xs text-low">
          {ms
            ? [
                t('dashboard.repos.wave', {
                  wave: ms.current_wave ?? ms.waves[0]?.wave ?? 0,
                  total: ms.waves.length,
                }),
                stoppedBy
                  ? t('dashboard.repos.stoppedBy', { issue: stoppedBy })
                  : t('dashboard.repos.runningIssues', { count: repo.running }),
              ].join(' · ')
            : repo.last_activity
              ? t('dashboard.repos.lastActivity', {
                  time: formatDurationSince(repo.last_activity),
                })
              : t('dashboard.repos.noActivity')}
        </span>
      </div>

      {ms && (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            {ms.waves.map((wave) => (
              <div key={wave.wave} className="flex items-center gap-[3px]">
                <span className="mr-0.5 font-mono text-[10px] text-low">
                  W{wave.wave}
                </span>
                {wave.cells.map((cell) => (
                  <i
                    key={cell.number}
                    title={`#${cell.number} · ${t(`dashboard.repos.cell.${cell.state}`)}`}
                    className={cn(
                      'block h-2 w-3.5 rounded-sm',
                      CELL_CLASS[cell.state] ?? CELL_CLASS.pending
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-md-outline-variant/60">
              <div
                className="h-full rounded-full bg-success"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-right font-mono text-[11px] text-low">
              {t('dashboard.repos.closed', {
                closed: ms.issues_closed,
                total: ms.issues_total,
              })}
            </span>
          </div>
        </>
      )}

      <div className="grid w-full grid-cols-2 gap-2 border-t border-border pt-2.5 sm:grid-cols-4">
        <Stat value={repo.running} label={t('dashboard.repos.running')} />
        <Stat
          value={repo.blocked}
          label={t('dashboard.repos.blocked')}
          className={repo.blocked > 0 ? 'text-warning' : undefined}
        />
        <Stat value={repo.open_prs} label={t('dashboard.repos.openPrs')} />
        <Stat
          value={usdFormatter.format(ms?.cost_usd ?? 0)}
          label={t('dashboard.repos.milestoneCost')}
          className="font-mono text-sm"
        />
      </div>
    </button>
  );
}

function Stat({
  value,
  label,
  className,
}: {
  value: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col">
      <b className={cn('text-base font-semibold text-high', className)}>
        {value}
      </b>
      <small className="text-[11px] text-low">{label}</small>
    </div>
  );
}

export function ReposPanel({ repos }: { repos: RepoOverview[] }) {
  const { t } = useTranslation('common');
  if (repos.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2.5"
      aria-label={t('dashboard.repos.title')}
    >
      <SectionTitle>
        {t('dashboard.repos.title')}
        <span className="font-normal normal-case tracking-normal">
          {t('dashboard.repos.subtitle')}
        </span>
      </SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-3">
        {repos.map((repo) => (
          <RepoCard key={repo.repo_id} repo={repo} />
        ))}
      </div>
    </section>
  );
}
