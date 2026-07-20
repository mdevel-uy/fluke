import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { cn } from '@/shared/lib/utils';
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
    <li
      className={cn(
        'group flex items-start gap-4 px-4 py-4',
        'bg-md-surface-container-lowest border-b border-md-outline-variant last:border-b-0',
        'transition-all duration-200',
        'hover:shadow-card-hover hover:border-b-md-outline-variant',
        'hover:-translate-y-px hover:z-10 hover:relative'
      )}
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
            className="text-title-sm font-hanken text-md-on-surface group-hover:text-md-primary transition-colors duration-200 truncate leading-snug"
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
          <span className="text-body-sm text-md-on-surface-variant">
            {t('issues.authorPrefix')} {issue.author}
          </span>
        </div>
      </div>

      {isOpen && (
        <button
          type="button"
          onClick={handleAssign}
          disabled={!repoId}
          className={cn(
            'shrink-0 flex items-center gap-1.5 px-3 py-1.5',
            'border border-md-primary text-md-primary rounded-lg',
            'text-body-sm font-semibold',
            'hover:bg-md-primary-container/10',
            'active:scale-95 transition-all duration-200',
            'opacity-0 group-hover:opacity-100',
            'disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          <MaterialIcon name="person_add" size="sm" />
          {t('issues.assignToAgent')}
        </button>
      )}
    </li>
  );
}
