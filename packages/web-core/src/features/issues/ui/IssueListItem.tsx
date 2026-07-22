import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-warning/10 text-warning border border-warning/20',
  in_progress: 'bg-md-primary/10 text-md-primary border border-md-primary/20',
  in_review: 'bg-merged/10 text-merged border border-merged/20',
  done: 'bg-success/10 text-success border border-success/20',
};

interface IssueListItemProps {
  issue: RepoIssue;
  repoId: string | undefined;
  linkedTask?: WorkerTask;
  isSelected?: boolean;
  onSelect?: (issue: RepoIssue) => void;
  onRemoveLabel?: (issueNumber: number, labelName: string) => Promise<void>;
  onArchive?: (issueNumber: number) => Promise<void>;
}

export function IssueListItem({
  issue,
  repoId,
  linkedTask,
  isSelected,
  onSelect,
  onRemoveLabel,
  onArchive,
}: IssueListItemProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const isOpen = issue.state === 'open';
  const [archiving, setArchiving] = useState(false);
  const [removingLabel, setRemovingLabel] = useState<string | null>(null);

  const handleAssign = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!repoId) return;
    void AssignToAgentDialog.show({ issue, repoId });
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

  const handleRemoveLabel = async (labelName: string) => {
    if (!onRemoveLabel) return;
    setRemovingLabel(labelName);
    try {
      await onRemoveLabel(issue.number, labelName);
    } finally {
      setRemovingLabel(null);
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
  const statusLabel = statusKey
    ? t(`issues.taskStatus.${statusKey}`, { defaultValue: statusKey })
    : null;
  const statusStyle =
    (statusKey && STATUS_STYLES[statusKey]) ||
    'bg-md-surface-container text-md-on-surface-variant border border-md-outline-variant';

  const linkLabel = linkedTask?.workspace_id
    ? t('issues.taskLinked.openWorkspace')
    : t('issues.taskLinked.viewInSprint');

  return (
    <li
      className={cn(
        'group flex items-start gap-3 px-3 py-2',
        'border-b border-md-outline-variant last:border-b-0',
        'transition-colors duration-150 cursor-pointer',
        isSelected
          ? 'bg-sel border-l-2 border-l-brand-on-surface'
          : 'bg-card hover:bg-secondary/60'
      )}
      onClick={() => onSelect?.(issue)}
    >
      <div className="mt-0.5 shrink-0">
        <MaterialIcon
          name="radio_button_checked"
          fill={isOpen ? 1 : 0}
          size="base"
          className="text-md-primary"
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-geist text-code-sm text-md-on-surface-variant shrink-0">
            #{issue.number}
          </span>
          <span
            className="text-title-sm font-sans text-md-on-surface group-hover:text-md-primary transition-colors duration-200 truncate leading-snug"
            title={issue.title}
          >
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {issue.labels.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {issue.labels.map((label) => (
                <IssueLabelChip
                  key={label.name}
                  label={label}
                  onRemove={
                    isOpen && onRemoveLabel
                      ? () => void handleRemoveLabel(label.name)
                      : undefined
                  }
                />
              ))}
              {removingLabel && (
                <MaterialIcon
                  name="progress_activity"
                  size="sm"
                  className="animate-spin text-md-on-surface-variant"
                />
              )}
            </div>
          )}
          <span className="text-body-sm text-md-on-surface-variant">
            {t('issues.authorPrefix')} {issue.author}
          </span>
          {issue.milestone && (
            <span className="text-body-sm italic text-md-on-surface-variant">
              {issue.milestone}
            </span>
          )}
        </div>
      </div>

      {linkedTask ? (
        <div
          className="shrink-0 flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5',
              'text-label-caps font-geist font-semibold uppercase tracking-widest',
              statusStyle
            )}
          >
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={handleViewTask}
            className={cn(
              'flex items-center gap-1.5 px-2.5 h-[26px]',
              'border border-brand-on-surface/40 text-brand-on-surface rounded-sm',
              'text-body-sm',
              'hover:bg-md-primary-container/10',
              'transition-colors duration-150'
            )}
            title={linkLabel}
          >
            <MaterialIcon name="open_in_new" size="sm" />
            {linkLabel}
          </button>
        </div>
      ) : (
        isOpen && (
          <div
            className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            {onArchive && (
              <button
                type="button"
                onClick={handleArchive}
                disabled={archiving}
                title={t('issues.archiveAction')}
                className={cn(
                  'flex items-center justify-center h-[26px] w-[26px] rounded-sm',
                  'text-md-on-surface-variant hover:bg-md-surface-container',
                  'transition-colors duration-150',
                  'disabled:opacity-40 disabled:cursor-not-allowed'
                )}
              >
                <MaterialIcon
                  name={archiving ? 'progress_activity' : 'archive'}
                  size="sm"
                  className={archiving ? 'animate-spin' : ''}
                />
              </button>
            )}
            <button
              type="button"
              onClick={handleAssign}
              disabled={!repoId}
              className={cn(
                'flex items-center gap-1.5 px-2.5 h-[26px]',
                'border border-brand-on-surface/40 text-brand-on-surface rounded-sm',
                'text-body-sm',
                'hover:bg-md-primary-container/10',
                'transition-colors duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              <MaterialIcon name="person_add" size="sm" />
              {t('issues.assignToAgent')}
            </button>
          </div>
        )
      )}
    </li>
  );
}
