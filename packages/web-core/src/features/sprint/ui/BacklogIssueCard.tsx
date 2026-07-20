import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
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
    <article className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-outline-variant rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-md-primary/30 hover:-translate-y-px">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-geist text-code-sm text-md-on-surface-variant shrink-0">
          #{issue.number}
        </span>
        <span
          className="text-body-md font-hanken text-md-on-surface font-medium leading-snug line-clamp-2 group-hover:text-md-primary transition-colors duration-200"
          title={issue.title}
        >
          {issue.title}
        </span>
      </div>
      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {issue.labels.map((label) => (
            <IssueLabelChip key={label.name} label={label.name} />
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="tonal"
              size="xs"
              disabled={isAssigning || workers.length === 0}
              className="active:scale-95 transition-all duration-200"
            >
              <MaterialIcon
                name={isAssigning ? 'progress_activity' : 'play_arrow'}
                size="xs"
                className={cn(isAssigning && 'animate-spin')}
              />
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
                  <span className="mr-1.5 text-base" aria-hidden="true">
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
