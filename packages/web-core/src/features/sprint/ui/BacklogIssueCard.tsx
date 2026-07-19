import { useTranslation } from 'react-i18next';
import { Loader2, Play } from 'lucide-react';
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
    <article className="group flex flex-col gap-2.5 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card hover:border-border">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="font-ibm-plex-mono text-xs text-low shrink-0">
          #{issue.number}
        </span>
        <span
          className="text-sm text-high font-medium leading-snug line-clamp-2"
          title={issue.title}
        >
          {issue.title}
        </span>
      </div>
      {issue.labels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {issue.labels.map((label) => (
            <IssueLabelChip key={label} label={label} />
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
            >
              {isAssigning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
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
