import { useTranslation } from 'react-i18next';
import { ExternalLink, Play } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  in_progress: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  in_review: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400',
};

interface IssueListItemProps {
  issue: RepoIssue;
  repoId: string | undefined;
  linkedTask?: WorkerTask;
}

export function IssueListItem({
  issue,
  repoId,
  linkedTask,
}: IssueListItemProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const isOpen = issue.state === 'open';

  const handleAssign = () => {
    if (!repoId) return;
    void AssignToAgentDialog.show({ issue, repoId });
  };

  const handleViewTask = () => {
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
    (statusKey && STATUS_STYLES[statusKey]) || 'bg-secondary text-low';

  return (
    <li className="group flex items-start gap-4 px-5 py-4 border-b border-border/50 last:border-b-0 transition-colors hover:bg-secondary/60">
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-ibm-plex-mono text-xs text-low shrink-0">
            #{issue.number}
          </span>
          <span
            className="text-sm text-high font-medium truncate leading-snug"
            title={issue.title}
          >
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {issue.labels.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {issue.labels.map((label) => (
                <IssueLabelChip key={label.name} label={label.name} />
              ))}
            </div>
          )}
          <span className="text-xs text-low">
            {t('issues.authorPrefix')} {issue.author}
          </span>
        </div>
      </div>
      {linkedTask ? (
        <div className="shrink-0 flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusStyle}`}
          >
            {statusLabel}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleViewTask}
            className="opacity-70 group-hover:opacity-100 transition-opacity"
            title={
              linkedTask.workspace_id
                ? t('issues.taskLinked.openWorkspace')
                : t('issues.taskLinked.viewInSprint')
            }
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {linkedTask.workspace_id
              ? t('issues.taskLinked.openWorkspace')
              : t('issues.taskLinked.viewInSprint')}
          </Button>
        </div>
      ) : (
        isOpen && (
          <Button
            variant="tonal"
            size="sm"
            onClick={handleAssign}
            disabled={!repoId}
            className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
          >
            <Play className="h-3.5 w-3.5" />
            {t('issues.assignToAgent')}
          </Button>
        )
      )}
    </li>
  );
}
