import { useTranslation } from 'react-i18next';
import type { ProjectIssue } from '@/features/issues/types';
import { IssueLabelChip } from './IssueLabelChip';

interface IssueListItemProps {
  issue: ProjectIssue;
}

export function IssueListItem({ issue }: IssueListItemProps) {
  const { t } = useTranslation('common');

  return (
    <li className="flex flex-col gap-half px-base py-base border-b border-border last:border-b-0">
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
    </li>
  );
}
