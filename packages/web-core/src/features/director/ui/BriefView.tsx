import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircleIcon, CircleIcon } from '@phosphor-icons/react';
import type { MissionDetail } from 'shared/types';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { cn } from '@/shared/lib/utils';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { useRepos } from '@/shared/hooks/useRepos';
import { useApproveBrief, useUpdateMission } from '../model/useMissions';

const AUTONOMY = ['step', 'brief_pr', 'autopilot'] as const;

/**
 * Live brief of a mission: items with their required-field checklist, the
 * roles the work needs, the autonomy dial and the G1 button. Completeness
 * comes from the server; this view never decides it.
 */
export function BriefView({ detail }: { detail: MissionDetail }) {
  const { t } = useTranslation('common');
  const { mission } = detail;
  const update = useUpdateMission(mission.id);
  const approve = useApproveBrief(mission.id);
  const { data: workers = [] } = useWorkers();
  const analysts = workers.filter((w) => w.role === 'analyst' && !w.archived);
  const { repos } = useRepos();
  const [analystId, setAnalystId] = useState<string | undefined>(undefined);

  const canApprove = detail.complete && mission.status === 'brief_ready';
  const missingTitle = detail.missing.includes('title');
  const missingRepo = detail.missing.includes('repo');

  return (
    <div className="flex flex-col gap-base p-base text-sm">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-high truncate">
            {mission.title || t('director.brief.untitled')}
          </h2>
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-normal">
            {t(`director.status.${mission.status}`)}
          </span>
        </div>
        {mission.analyst_task_id ? (
          <Check
            ok={!missingRepo}
            label={`${t('director.brief.repo')}: ${detail.repo_name ?? '-'}`}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Check ok={!missingRepo} label={t('director.brief.repo')} />
            <Select
              value={mission.repo_id ?? undefined}
              onValueChange={(repo_id) => update.mutate({ repo_id })}
            >
              <SelectTrigger className="h-7 flex-1 text-xs">
                <SelectValue placeholder="-" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {missingTitle && <Check ok={false} label={t('director.brief.title')} />}
      </div>

      {detail.items.length === 0 ? (
        <p className="text-xs text-low">{t('director.brief.noItems')}</p>
      ) : (
        detail.items.map(({ item, checklist }, i) => (
          <section
            key={item.id}
            className="flex flex-col gap-1 rounded-md border border-md-outline-variant p-2"
          >
            <p className="text-xs font-medium text-high">
              {i + 1}. [{t(`director.kinds.${item.kind}`)}] {item.title}
            </p>
            {checklist.map((field) => (
              <div key={field.key} className="flex flex-col">
                <Check
                  ok={field.filled}
                  optional={!field.required}
                  label={t(`director.fields.${field.key}`)}
                />
                {item.fields[field.key] && (
                  <p className="ml-5 whitespace-pre-wrap text-xs text-low">
                    {item.fields[field.key]}
                  </p>
                )}
              </div>
            ))}
          </section>
        ))
      )}

      {detail.roles_needed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-high">
            {t('director.brief.team')}
          </p>
          <div className="flex flex-wrap gap-1">
            {detail.roles_needed.map((role) => (
              <span
                key={role}
                className="rounded-full border border-md-outline-variant px-2 py-0.5 text-xs text-normal"
              >
                {t(`workers.roles.${role}`)}
              </span>
            ))}
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-high">
          {t('director.autonomy.label')}
        </span>
        <Select
          value={mission.autonomy}
          onValueChange={(autonomy) => update.mutate({ autonomy })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTONOMY.map((a) => (
              <SelectItem key={a} value={a}>
                {t(`director.autonomy.${a}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {mission.status === 'brief_ready' || mission.status === 'clarifying' ? (
        <div className="flex flex-col gap-2">
          {analysts.length > 1 && (
            <Select
              value={analystId ?? analysts[0].id}
              onValueChange={setAnalystId}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {analysts.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <PrimaryButton
            disabled={!canApprove || approve.isPending}
            actionIcon={approve.isPending ? 'spinner' : undefined}
            onClick={() => approve.mutate(analystId)}
            value={t('director.brief.approve')}
          />
          {!canApprove && (
            <p className="text-xs text-low">{t('director.brief.incomplete')}</p>
          )}
          {approve.error && (
            <p className="text-xs text-danger">{approve.error.message}</p>
          )}
        </div>
      ) : (
        detail.briefs.length > 0 && (
          <p className="text-xs text-low">
            {t('director.brief.sent', { version: detail.briefs[0].version })}
            {detail.issue_numbers.length > 0 &&
              ` ${t('director.brief.issues', {
                list: detail.issue_numbers.map((n) => `#${n}`).join(', '),
              })}`}
          </p>
        )
      )}
    </div>
  );
}

function Check({
  ok,
  label,
  optional = false,
}: {
  ok: boolean;
  label: string;
  optional?: boolean;
}) {
  const { t } = useTranslation('common');
  const Icon = ok ? CheckCircleIcon : CircleIcon;
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-xs',
        ok ? 'text-normal' : 'text-low'
      )}
    >
      <Icon
        className={cn('size-icon-sm shrink-0', ok && 'text-success')}
        weight={ok ? 'fill' : 'regular'}
      />
      {label}
      {optional && !ok && (
        <span className="text-low">({t('director.brief.optional')})</span>
      )}
    </span>
  );
}
