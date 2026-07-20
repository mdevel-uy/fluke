import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Loader2, Play } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import type { RepoIssue } from '@/features/issues/types';
import { cn } from '@/shared/lib/utils';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';

interface IssueListItemProps {
  issue: RepoIssue;
  repoId: string | undefined;
  isSelected?: boolean;
  onSelect?: (issue: RepoIssue) => void;
  onRemoveLabel?: (issueNumber: number, labelName: string) => Promise<void>;
  onArchive?: (issueNumber: number) => Promise<void>;
}

export function IssueListItem({
  issue,
  repoId,
  isSelected,
  onSelect,
  onRemoveLabel,
  onArchive,
}: IssueListItemProps) {
  const { t } = useTranslation('common');
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

  return (
    <li
      className={cn(
        'group flex items-start gap-4 px-5 py-4 border-b border-border/50 last:border-b-0 transition-colors cursor-pointer',
        isSelected
          ? 'bg-brand/5 border-l-2 border-l-brand'
          : 'hover:bg-secondary/60'
      )}
      onClick={() => onSelect?.(issue)}
    >
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
                <IssueLabelChip
                  key={label.name}
                  label={label.name}
                  color={label.color}
                  onRemove={
                    isOpen && onRemoveLabel
                      ? () => void handleRemoveLabel(label.name)
                      : undefined
                  }
                />
              ))}
              {removingLabel && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-low" />
              )}
            </div>
          )}
          <span className="text-xs text-low">
            {t('issues.authorPrefix')} {issue.author}
          </span>
          {issue.milestone && (
            <span className="text-xs text-low italic">{issue.milestone}</span>
          )}
        </div>
      </div>
      {isOpen && (
        <div
          className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {onArchive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleArchive}
              disabled={archiving}
              title={t('issues.archiveAction')}
              className="h-7 w-7 p-0"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5 text-low" />
              )}
            </Button>
          )}
          <Button
            variant="tonal"
            size="sm"
            onClick={handleAssign}
            disabled={!repoId}
            className="h-7"
          >
            <Play className="h-3.5 w-3.5" />
            {t('issues.assignToAgent')}
          </Button>
        </div>
      )}
    </li>
  );
}
