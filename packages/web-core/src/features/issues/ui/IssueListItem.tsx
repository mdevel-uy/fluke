import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import type { RepoIssue } from '@/features/issues/types';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';

interface IssueListItemProps {
  issue: RepoIssue;
  repoId: string | undefined;
}

export function IssueListItem({ issue, repoId }: IssueListItemProps) {
  const { t } = useTranslation('common');
  const isOpen = issue.state === 'open';

  const handleAssign = () => {
    if (!repoId) return;
    void AssignToAgentDialog.show({ issue, repoId });
  };

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
                <IssueLabelChip key={label} label={label} />
              ))}
            </div>
          )}
          <span className="text-xs text-low">
            {t('issues.authorPrefix')} {issue.author}
          </span>
        </div>
      </div>
      {isOpen && (
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
      )}
    </li>
  );
}
