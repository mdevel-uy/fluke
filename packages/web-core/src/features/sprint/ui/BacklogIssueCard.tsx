import { useTranslation } from 'react-i18next';
import { PlayIcon, SpinnerIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import type { RepoIssue } from '@/features/issues';
import type { Worker } from '@/features/sprint/types';
import { IssueLabelChip } from './IssueLabelChip';

interface BacklogIssueCardProps {
  issue: RepoIssue;
  workers: Worker[];
  isAssigning: boolean;
  onAssign: (workerId: string) => void;
}

export function BacklogIssueCard({
  issue,
  workers,
  isAssigning,
  onAssign,
}: BacklogIssueCardProps) {
  const { t } = useTranslation('common');

  return (
    <article className="flex flex-col gap-half p-base bg-primary border border-border rounded-sm">
      <div className="flex items-baseline gap-half min-w-0">
        <span className="text-xs text-low shrink-0">#{issue.number}</span>
        <span
          className="text-sm text-normal font-medium truncate"
          title={issue.title}
        >
          {issue.title}
        </span>
      </div>
      {issue.labels.length > 0 && (
        <div className="flex items-center gap-half flex-wrap">
          {issue.labels.map((label) => (
            <IssueLabelChip key={label.name} label={label.name} />
          ))}
        </div>
      )}
      <div className="flex justify-end pt-half">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              disabled={isAssigning || workers.length === 0}
            >
              {isAssigning ? (
                <SpinnerIcon className="mr-1 size-icon-sm animate-spin" />
              ) : (
                <PlayIcon className="mr-1 size-icon-sm" weight="bold" />
              )}
              {t('sprint.backlog.assign')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {workers.length === 0 ? (
              <DropdownMenuItem disabled>
                {t('sprint.backlog.noWorkers')}
              </DropdownMenuItem>
            ) : (
              workers.map((worker) => (
                <DropdownMenuItem
                  key={worker.id}
                  onSelect={() => onAssign(worker.id)}
                >
                  <span className="mr-1" aria-hidden="true">
                    {worker.emoji}
                  </span>
                  <span className="truncate">{worker.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
