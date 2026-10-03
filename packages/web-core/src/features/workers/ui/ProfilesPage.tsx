import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerResponse } from 'shared/types';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { cn } from '@/shared/lib/utils';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useConcurrencyStatus } from '@/shared/hooks/useConcurrencyStatus';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  useAllWorkerTasks,
  useWorkers,
} from '@/features/sprint/model/useWorkers';
import type { WorkerTask } from '@/features/sprint/types';
import { instanceLabel } from '../model/instance';
import { WorkerFormDialog } from './WorkerFormDialog';

/**
 * Perfiles (fluke v2, #682): replaces the Workers screen. Contract:
 * design/mockups/fluke-v2/pantallas.html, tab "4 · Perfiles".
 *
 * A profile is a template; every task that starts creates an ephemeral
 * instance of it (`profile·xxx`) that works in its own workspace and is
 * discarded when done. Clicking a card edits the profile.
 */

const ACTIVE = new Set(['queued', 'in_progress', 'waiting_user', 'in_review']);

const INITIALS: Record<string, string> = {
  fullstack: 'FS',
  frontend: 'FE',
  backend: 'BE',
  analyst: 'AN',
  reviewer: 'RV',
  designer: 'DS',
  qa: 'QA',
};

const ROLE_COLOR: Record<string, string> = {
  developer: 'bg-md-primary text-md-on-primary',
  analyst: 'bg-warning text-warning-foreground',
  reviewer: 'bg-violet-500 text-white',
  designer: 'bg-pink-400 text-white',
  qa: 'bg-success text-success-foreground',
};

function initials(name: string) {
  const key = name.trim().toLowerCase();
  if (INITIALS[key]) return INITIALS[key];
  const words = key.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0][0] + words[1][0] : key.slice(0, 2)
  ).toUpperCase();
}

function executorLabel(executor: string | null | undefined) {
  if (!executor) return null;
  return executor
    .toLowerCase()
    .split('_')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}

function soulSummary(soul: string) {
  const text = soul
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

export function ProfilesPage() {
  const { t } = useTranslation('common');
  usePageTitle(t('workers.title'));
  const { data: workers } = useWorkers();
  const { tasks } = useAllWorkerTasks(workers);
  const { data: concurrency } = useConcurrencyStatus();

  const profiles = useMemo(
    () =>
      (workers ?? []).filter((w) => !w.archived && w.role !== 'orchestrator'),
    [workers]
  );
  const tasksByWorker = useMemo(() => {
    const map = new Map<string, WorkerTask[]>();
    for (const task of tasks) {
      if (!ACTIVE.has(task.status) || !task.workspace_id) continue;
      map.set(task.worker_id, [...(map.get(task.worker_id) ?? []), task]);
    }
    return map;
  }, [tasks]);

  const limit = concurrency?.limit ?? 0;
  const used = concurrency?.used ?? 0;

  return (
    <div className="flex h-full w-full flex-col bg-primary">
      <PageHeader
        title={t('workers.title')}
        actions={
          <button
            type="button"
            onClick={() => void WorkerFormDialog.show({})}
            className="inline-flex h-8 items-center rounded-md bg-md-primary px-3 text-[13px] font-medium text-md-on-primary hover:opacity-90"
          >
            {t('profiles.new')}
          </button>
        }
      />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-[1240px] content-start gap-3.5 px-[18px] py-4">
          <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-3.5 py-3 text-[13px] text-normal">
            <span className="min-w-0 flex-[1_1_420px]">
              {t('profiles.bannerStart')}{' '}
              <b className="font-medium text-high">
                {t('profiles.bannerInstance')}
              </b>{' '}
              {t('profiles.bannerEnd')}
            </span>
            {limit > 0 && (
              <span className="inline-flex items-center gap-2">
                <span className="tabular-nums">
                  {t('profiles.slots', { used, limit })}
                </span>
                <span className="inline-flex gap-1">
                  {Array.from({ length: limit }, (_, k) => (
                    <i
                      key={k}
                      className={cn(
                        'size-[11px] rounded-[3px] border border-md-outline-variant',
                        k < used && 'border-md-primary bg-md-primary'
                      )}
                    />
                  ))}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void SettingsDialog.show({ initialSection: 'general' })
                  }
                  className="inline-flex h-7 items-center rounded-md border border-md-outline-variant bg-md-surface-container px-2.5 text-xs text-high hover:border-md-on-surface-variant"
                >
                  {t('profiles.adjustInSettings')}
                </button>
              </span>
            )}
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                instances={tasksByWorker.get(p.id) ?? []}
              />
            ))}
            <button
              type="button"
              onClick={() => void WorkerFormDialog.show({})}
              className="grid min-h-[200px] place-content-center gap-1 rounded-[10px] border border-dashed border-md-outline-variant p-3.5 text-center text-[13px] text-normal hover:border-md-on-surface-variant"
            >
              <b className="text-sm text-high">{t('profiles.new')}</b>
              <span>{t('profiles.newHint')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileCard({
  profile,
  instances,
}: {
  profile: WorkerResponse;
  instances: WorkerTask[];
}) {
  const { t } = useTranslation('common');
  const executor = executorLabel(profile.executor);
  const agent = [
    executor ?? t('profiles.defaultAgent'),
    profile.model ?? t('profiles.defaultModel'),
  ].join(' · ');

  return (
    <button
      type="button"
      onClick={() => void WorkerFormDialog.show({ worker: profile })}
      className="grid content-start gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low p-3.5 text-left hover:border-md-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary"
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-[30px] flex-none place-items-center rounded-lg font-mono text-[11px] font-semibold',
            ROLE_COLOR[profile.role] ?? 'bg-md-outline text-md-on-surface'
          )}
        >
          {initials(profile.name)}
        </span>
        <div className="min-w-0">
          <b className="block text-[14.5px] font-semibold text-high">
            {profile.name}
          </b>
          <small className="text-xs text-normal">
            {t('profiles.baseRole', {
              role: t(`workers.roles.${profile.role}`),
            })}
          </small>
        </div>
      </div>
      {profile.soul.trim() && (
        <p className="m-0 border-l-2 border-md-outline-variant pl-2.5 text-[12.5px] leading-relaxed text-normal">
          {soulSummary(profile.soul)}
        </p>
      )}
      <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <dt className="text-normal">{t('profiles.agent')}</dt>
        <dd className="m-0 min-w-0 text-high">{agent}</dd>
        <dt className="text-normal">{t('profiles.github')}</dt>
        <dd className="m-0 min-w-0 text-high">
          {profile.has_github_pat
            ? t('profiles.ownPat', { login: profile.github_login ?? '' })
            : t('profiles.userPat')}
        </dd>
        {profile.migrated_from && (
          <>
            <dt className="text-normal">{t('profiles.migratedFrom')}</dt>
            <dd className="m-0 min-w-0 text-high">{profile.migrated_from}</dd>
          </>
        )}
      </dl>
      <div className="grid gap-1.5 border-t border-md-outline-variant pt-2.5">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-normal">
          {t('profiles.instancesNow')}
        </span>
        {instances.length === 0 ? (
          <span className="font-mono text-[11.5px] text-low">
            {t('profiles.none')}
          </span>
        ) : (
          instances.map((task) => (
            <div
              key={task.id}
              className="flex justify-between gap-2 font-mono text-[11.5px] text-normal"
            >
              <b className="font-medium text-md-primary">
                {instanceLabel(profile.name, task.workspace_id)}
              </b>
              <span className="truncate">
                {task.issue_number != null ? `#${task.issue_number} · ` : ''}
                {t(`issues.taskStatus.${task.status}`, {
                  defaultValue: task.status,
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </button>
  );
}
