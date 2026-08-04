import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
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
      className="group flex flex-col gap-2.5 p-3.5 bg-md-surface-container-lowest border border-md-outline-variant rounded-lg shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-md-primary/30 hover:-translate-y-px cursor-pointer"
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
      {/* Top row: number + title + more menu */}
      <div className="flex items-start gap-2 min-w-0">
        <span className="font-geist text-code-sm text-md-on-surface-variant shrink-0 mt-0.5">
          #{issue.number}
        </span>
        <div className="flex-1 min-w-0">
          <span
            className="text-body-md font-sans text-md-on-surface font-medium leading-snug line-clamp-2 group-hover:text-md-primary transition-colors duration-200"
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
                type="button"
                className="shrink-0 p-1 rounded-md text-md-on-surface-variant opacity-0 group-hover:opacity-100 hover:text-md-on-surface hover:bg-md-surface-container active:scale-95 transition-all duration-200 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-md-primary/40"
                aria-label={t('sprint.backlog.moreActions')}
              >
                <MaterialIcon name="more_horiz" size="sm" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuLabel className="text-label-caps font-geist font-semibold uppercase tracking-widest text-md-on-surface-variant">
                {t('sprint.backlog.setPriority')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onPriorityChange(null)}>
                <span className="text-md-on-surface-variant text-body-sm">
                  {t('sprint.detail.noPriority')}
                </span>
              </DropdownMenuItem>
              {PRIORITIES.map((p) => (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => onPriorityChange(p)}
                  className={
                    issue.priority === p ? 'bg-md-surface-container' : ''
                  }
                >
                  <PriorityBadge priority={p} showLabel />
                </DropdownMenuItem>
              ))}
              {workers.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-label-caps font-geist font-semibold uppercase tracking-widest text-md-on-surface-variant">
                    {t('sprint.backlog.assignTo')}
                  </DropdownMenuLabel>
                  {workers.map((worker) => (
                    <DropdownMenuItem
                      key={worker.id}
                      onSelect={() => onAssign(worker.id)}
                      disabled={isAssigning}
                    >
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
