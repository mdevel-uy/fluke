import { useTranslation } from 'react-i18next';
import { Loader2, Play } from 'lucide-react';
import { DotsThreeIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import type { RepoIssue, IssuePriority } from '@/features/issues/types';
import type { Worker } from '@/features/sprint/types';
import { IssueLabelChip } from './IssueLabelChip';
import { PriorityBadge } from './PriorityBadge';
import { EpicChip } from './EpicChip';

interface BacklogIssueCardProps {
  issue: RepoIssue;
  workers: Worker[];
  isAssigning: boolean;
  onAssign: (workerId: string) => void;
  onPriorityChange: (priority: IssuePriority | null) => void;
  onClick: () => void;
}

const PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

export function BacklogIssueCard({
  issue,
  workers,
  isAssigning,
  onAssign,
  onPriorityChange,
  onClick,
}: BacklogIssueCardProps) {
  const { t } = useTranslation('common');

  return (
    <article
      className="group flex flex-col gap-2 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft transition-all duration-150 hover:shadow-card hover:border-border cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Top row: number + priority + title */}
      <div className="flex items-start gap-2 min-w-0">
        <span className="font-ibm-plex-mono text-xs text-low shrink-0 mt-0.5">
          #{issue.number}
        </span>
        <div className="flex-1 min-w-0">
          <span
            className="text-sm text-high font-medium leading-snug line-clamp-2"
            title={issue.title}
          >
            {issue.title}
          </span>
        </div>
        {/* More menu — stop propagation to prevent card click */}
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="shrink-0 p-1 rounded-md text-low opacity-0 group-hover:opacity-100 hover:text-high hover:bg-secondary transition-all focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-brand/40"
                aria-label={t('sprint.backlog.moreActions')}
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuLabel className="text-xs text-low">
                {t('sprint.backlog.setPriority')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onPriorityChange(null)}>
                <span className="text-low text-xs">
                  {t('sprint.detail.noPriority')}
                </span>
              </DropdownMenuItem>
              {PRIORITIES.map((p) => (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => onPriorityChange(p)}
                  className={issue.priority === p ? 'bg-secondary' : ''}
                >
                  <PriorityBadge priority={p} showLabel />
                </DropdownMenuItem>
              ))}
              {workers.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-low">
                    {t('sprint.backlog.assignTo')}
                  </DropdownMenuLabel>
                  {workers.map((worker) => (
                    <DropdownMenuItem
                      key={worker.id}
                      onSelect={() => onAssign(worker.id)}
                      disabled={isAssigning}
                    >
                      <span className="mr-1.5 text-base" aria-hidden="true">
                        {worker.emoji}
                      </span>
                      <span className="truncate">{worker.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Meta chips: priority, epic, labels */}
      {(issue.priority || issue.milestone || issue.labels.length > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {issue.priority && (
            <PriorityBadge priority={issue.priority} showLabel />
          )}
          {issue.milestone && <EpicChip milestone={issue.milestone} />}
          {issue.labels.map((label) => (
            <IssueLabelChip key={label.name} label={label} />
          ))}
        </div>
      )}

      {/* Assign button */}
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
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
