import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ExternalLink,
  Gavel,
  Loader2,
  UserCog,
  UserPlus,
} from 'lucide-react';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';
import { ReassignTaskDialog } from './ReassignTaskDialog';
import { PmDecisionDialog, hasPmDecisionPending } from './PmDecisionDialog';

const TASK_STATUS_STYLES: Record<string, string> = {
  queued: 'bg-warning/10 text-warning',
  in_progress: 'bg-mod/10 text-mod',
  waiting_user: 'bg-warning/10 text-warning',
  in_review: 'bg-info/10 text-info',
  approved: 'bg-success/10 text-success',
  done: 'bg-success/10 text-success',
};

const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-sm text-normal ' +
  'hover:bg-md-surface-container-high hover:text-high ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ' +
  'disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150';

function useTimeAgo(date: Date | string): string {
  const { t } = useTranslation('common');
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t('issues.table.timeAgo.justNow');
  if (mins < 60) return t('issues.table.timeAgo.minutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('issues.table.timeAgo.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('issues.table.timeAgo.days', { count: days });
  return t('issues.table.timeAgo.weeks', { count: Math.floor(days / 7) });
}

interface IssueTableRowProps {
  issue: RepoIssue;
  repoId: string | undefined;
  linkedTask?: WorkerTask;
  workerName?: string;
  branch?: string;
  isSelected?: boolean;
  onSelect?: (issue: RepoIssue) => void;
  onArchive?: (issueNumber: number) => Promise<void>;
}

export function IssueTableRow({
  issue,
  repoId,
  linkedTask,
  workerName,
  branch,
  isSelected,
  onSelect,
  onArchive,
}: IssueTableRowProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const isOpen = issue.state === 'open';
  const [archiving, setArchiving] = useState(false);
  const timeAgo = useTimeAgo(issue.updated_at);

  const handleAssign = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!repoId) return;
    void AssignToAgentDialog.show({ issue, repoId });
  };

  const pmDecisionPending = hasPmDecisionPending(issue);

  const handlePmDecision = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!repoId) return;
    void PmDecisionDialog.show({ issue, repoId });
  };

  const handleReassign = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!repoId || !linkedTask) return;
    void ReassignTaskDialog.show({
      task: linkedTask,
      repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onArchive) return;
    setArchiving(true);
    try {
      await onArchive(issue.number);
    } finally {
      setArchiving(false);
    }
  };

  const handleViewTask = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!linkedTask) return;
    if (linkedTask.workspace_id) {
      appNavigation.goToWorkspace(linkedTask.workspace_id);
    } else if (repoId) {
      appNavigation.goToSprint(repoId);
    }
  };

  const statusKey = linkedTask?.status;
  const linkLabel = linkedTask?.workspace_id
    ? t('issues.taskLinked.openWorkspace')
    : t('issues.taskLinked.viewInSprint');

  return (
    <tr
      className={cn(
        'group h-[30px] cursor-pointer border-b border-border last:border-b-0',
        'transition-colors duration-150',
        isSelected ? 'bg-sel' : 'hover:bg-secondary'
      )}
      onClick={() => onSelect?.(issue)}
    >
      <td className="whitespace-nowrap px-3 font-mono text-code text-normal">
        #{issue.number}
      </td>
      <td className="overflow-hidden px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-high" title={issue.title}>
            {issue.title}
          </span>
          {issue.labels.map((label) => (
            <IssueLabelChip
              key={label.name}
              label={label}
              className="shrink-0"
            />
          ))}
        </div>
      </td>
      <td className="whitespace-nowrap px-3">
        {statusKey ? (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-px text-xs lowercase',
              TASK_STATUS_STYLES[statusKey] ?? 'bg-secondary text-normal'
            )}
          >
            {t(`issues.taskStatus.${statusKey}`, { defaultValue: statusKey })}
          </span>
        ) : (
          <span className={cn('text-xs', isOpen ? 'text-normal' : 'text-low')}>
            {t(
              isOpen ? 'issues.drawer.stateOpen' : 'issues.drawer.stateClosed'
            )}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 text-sm text-normal">
        {workerName && linkedTask?.workspace_id ? (
          <button
            type="button"
            onClick={handleViewTask}
            aria-label={linkLabel}
            title={linkLabel}
            className="rounded-sm text-md-primary underline underline-offset-2 hover:text-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          >
            {workerName}
          </button>
        ) : (
          (workerName ?? <span className="text-low">—</span>)
        )}
      </td>
      <td className="overflow-hidden px-3 font-mono text-code text-normal">
        {branch ? (
          <span className="block truncate" title={branch}>
            {branch}
          </span>
        ) : (
          <span className="text-low">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-code text-low">
        {timeAgo}
      </td>
      <td className="px-2">
        <div
          className={cn(
            'flex items-center justify-end gap-1',
            !linkedTask?.workspace_id &&
              'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {linkedTask ? (
            <>
              <button
                type="button"
                onClick={handleReassign}
                disabled={!repoId}
                aria-label={t('issues.reassignAction')}
                title={t('issues.reassignAction')}
                className={ICON_BUTTON}
              >
                <UserCog className="h-4 w-4" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={handleViewTask}
                aria-label={linkLabel}
                title={linkLabel}
                className={ICON_BUTTON}
              >
                <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </>
          ) : (
            isOpen && (
              <>
                {onArchive && (
                  <button
                    type="button"
                    onClick={handleArchive}
                    disabled={archiving}
                    aria-label={t('issues.archiveAction')}
                    title={t('issues.archiveAction')}
                    className={ICON_BUTTON}
                  >
                    {archiving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Archive className="h-4 w-4" strokeWidth={1.75} />
                    )}
                  </button>
                )}
                {pmDecisionPending ? (
                  <Tooltip content={t('issues.pmDecision.assignBlocked')}>
                    <span className="inline-flex">
                      <button
                        type="button"
                        disabled
                        aria-label={t('issues.pmDecision.assignBlocked')}
                        className={ICON_BUTTON}
                      >
                        <UserPlus className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </span>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    onClick={handleAssign}
                    disabled={!repoId}
                    aria-label={t('issues.assignToAgent')}
                    title={t('issues.assignToAgent')}
                    className={ICON_BUTTON}
                  >
                    <UserPlus className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                )}
              </>
            )
          )}
          {isOpen && pmDecisionPending && (
            <button
              type="button"
              onClick={handlePmDecision}
              disabled={!repoId}
              aria-label={t('issues.pmDecision.action')}
              title={t('issues.pmDecision.action')}
              className={ICON_BUTTON}
            >
              <Gavel className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
