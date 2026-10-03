import { useTranslation } from 'react-i18next';
import type { DashboardOverview, RunningTask } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { ROLE_COLOR, initials } from '@/features/workers/model/profileAvatar';
import {
  contextRatio,
  agentLabel,
  formatDurationSince,
  usdFormatter,
} from '@/features/dashboard/model/dashboardMetrics';
import { Panel, PanelEmpty, meterTone } from './parts/primitives';

const PHASE_KINDS = ['design', 'tdd', 'dev', 'test', 'review', 'merge'];

const PHASE_CLASS: Record<string, string> = {
  done: 'border-success/45 bg-success/15 text-success',
  active: 'border-brand bg-brand text-on-brand',
  changes: 'border-warning/50 bg-warning/15 text-warning',
  stuck: 'border-error/50 bg-error/15 text-error',
  pending: 'border-border text-low',
  skip: 'border-dashed border-border text-low line-through opacity-50',
};

const CTX_CLASS = {
  muted: 'text-low',
  success: 'text-normal',
  warning: 'text-warning',
  error: 'text-error',
} as const;

function RunningRow({
  task,
  workspace,
}: {
  task: RunningTask;
  workspace: SidebarWorkspace | undefined;
}) {
  const { t } = useTranslation('common');
  const nav = useAppNavigation();
  const phases = PHASE_KINDS.map((kind) => ({
    kind,
    state: task.phases.find((p) => p.kind === kind)?.state ?? 'skip',
  }));
  const current = task.phases.find(
    (p) => p.state === 'active' || p.state === 'stuck'
  );
  const ratio = contextRatio(workspace);
  const stepPct =
    task.steps_total > 0 ? (task.steps_done / task.steps_total) * 100 : 0;

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md font-mono text-[10px] font-semibold',
              ROLE_COLOR[task.role] ?? 'bg-secondary text-normal'
            )}
          >
            {initials(task.profile)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm text-high">{task.profile}</div>
            <div className="truncate font-mono text-[11px] text-low">
              {[agentLabel(task.executor), task.model]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm">
        <div>
          {task.issue_number != null && (
            <b className="font-mono text-high">#{task.issue_number} </b>
          )}
          <span className="text-low">{task.repo_name}</span>
        </div>
        <div className="line-clamp-1 text-normal">{task.title}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex gap-[3px]">
          {phases.map((p) => (
            <span
              key={p.kind}
              title={t(`dashboard.runningPanel.phase.${p.kind}`)}
              className={cn(
                'rounded border px-1 py-px font-mono text-[10px] font-medium',
                PHASE_CLASS[p.state] ?? PHASE_CLASS.pending
              )}
            >
              {t(`dashboard.runningPanel.phaseShort.${p.kind}`)}
            </span>
          ))}
        </div>
        {current && (
          <div className="mt-0.5 text-[11.5px] text-low">
            {t(`dashboard.runningPanel.phase.${current.kind}`)}
            {task.status === 'waiting_user' &&
              ` · ${t('dashboard.runningPanel.waitingUser')}`}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        {task.steps_total > 0 ? (
          <div className="flex min-w-[120px] flex-col gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-md-outline-variant/60">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${stepPct}%` }}
              />
            </div>
            <span className="font-mono text-[11px] text-low">
              {t('dashboard.runningPanel.steps', {
                done: task.steps_done,
                total: task.steps_total,
              })}
            </span>
          </div>
        ) : (
          <span className="text-xs text-low">
            {t('dashboard.runningPanel.noPlan')}
          </span>
        )}
      </td>
      <td
        className={cn(
          'px-3 py-2.5 font-mono text-sm',
          CTX_CLASS[meterTone(ratio)]
        )}
      >
        {ratio === null ? '—' : `${Math.round(ratio * 100)}%`}
      </td>
      <td className="px-3 py-2.5 font-mono text-sm text-warning">
        {usdFormatter.format(task.cost_usd)}
      </td>
      <td className="px-3 py-2.5 font-mono text-sm text-low">
        {formatDurationSince(task.started_at)}
      </td>
      <td className="px-3 py-2.5 text-right">
        {task.workspace_id && (
          <button
            type="button"
            onClick={() => nav.goToWorkspace(task.workspace_id!)}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-normal hover:bg-secondary hover:text-high"
          >
            {t('dashboard.runningPanel.open')}
          </button>
        )}
      </td>
    </tr>
  );
}

export function RunningPanel({
  overview,
  workspaceById,
}: {
  overview: DashboardOverview;
  workspaceById: Map<string, SidebarWorkspace>;
}) {
  const { t } = useTranslation('common');
  const { running, queued, slots_used, slots_limit } = overview;
  const columns = [
    'profile',
    'issue',
    'phases',
    'steps',
    'context',
    'cost',
    'time',
  ] as const;

  return (
    <Panel
      title={t('dashboard.runningPanel.title')}
      chip={
        slots_limit > 0
          ? t('dashboard.runningPanel.slots', {
              used: slots_used,
              limit: slots_limit,
            })
          : slots_used
      }
      aside={t('dashboard.runningPanel.subtitle')}
    >
      {running.length === 0 ? (
        <PanelEmpty>{t('dashboard.runningPanel.empty')}</PanelEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-left font-mono text-[11px] font-medium uppercase tracking-wide text-low"
                  >
                    {t(`dashboard.runningPanel.col.${col}`)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {running.map((task) => (
                <RunningRow
                  key={task.task_id}
                  task={task}
                  workspace={
                    task.workspace_id
                      ? workspaceById.get(task.workspace_id)
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {queued.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2.5 text-xs text-low">
          <span className="font-mono font-medium uppercase tracking-wide">
            {t('dashboard.runningPanel.queue')}
          </span>
          {queued.map((q) => (
            <span key={q.task_id}>
              {q.issue_number != null && (
                <b className="font-mono text-high">#{q.issue_number} </b>
              )}
              {q.repo_name} · {q.profile}
            </span>
          ))}
          <span className="ml-auto">
            {t('dashboard.runningPanel.queueHint')}
          </span>
        </div>
      )}
    </Panel>
  );
}
