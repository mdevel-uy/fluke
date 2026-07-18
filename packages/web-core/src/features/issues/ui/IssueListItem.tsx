import { useTranslation } from 'react-i18next';
import { PlayIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
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
    <li className="flex items-start gap-base px-base py-base border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0 flex flex-col gap-half">
        <div className="flex items-baseline gap-half min-w-0">
          <span className="text-sm text-low shrink-0">#{issue.number}</span>
          <span
            className="text-sm text-normal font-medium truncate"
            title={issue.title}
          >
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-half flex-wrap">
          {issue.labels.length > 0 && (
            <div className="flex items-center gap-half flex-wrap">
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
        <PrimaryButton
          variant="tertiary"
          value={t('issues.assignToAgent')}
          actionIcon={PlayIcon}
          onClick={handleAssign}
          disabled={!repoId}
          className="shrink-0"
        />
      )}
    </li>
  );
}
