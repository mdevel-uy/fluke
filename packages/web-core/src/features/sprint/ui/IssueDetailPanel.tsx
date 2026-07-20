import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { cn } from '@/shared/lib/utils';
import type { RepoIssue, IssuePriority } from '@/features/issues/types';
import type { Worker } from '@/features/sprint/types';
import { IssueLabelChip } from './IssueLabelChip';
import { PriorityBadge } from './PriorityBadge';
import { EpicChip } from './EpicChip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';

interface IssueDetailPanelProps {
  issue: RepoIssue;
  workers: Worker[];
  repoName: string;
  onClose: () => void;
  onPriorityChange: (priority: IssuePriority | null) => void;
}

const PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

export function IssueDetailPanel({
  issue,
  workers,
  repoName,
  onClose,
  onPriorityChange,
}: IssueDetailPanelProps) {
  const { t } = useTranslation('common');

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const githubUrl = `https://github.com/${repoName}/issues/${issue.number}`;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 w-full max-w-[480px]',
          'bg-primary border-l border-border/70 shadow-overlay',
          'flex flex-col',
          'animate-in slide-in-from-right-8 duration-200'
        )}
        role="dialog"
        aria-modal="true"
        aria-label={t('sprint.detail.panelLabel')}
      >
        {/* Header */}
        <header className="flex items-start gap-3 px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-ibm-plex-mono text-low hover:text-brand transition-colors"
              >
                #{issue.number}
                <ArrowSquareOutIcon className="size-3" />
              </a>
              {issue.milestone && <EpicChip milestone={issue.milestone} />}
            </div>
            <h2 className="text-base font-semibold text-high leading-snug">
              {issue.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-lg text-low hover:text-high hover:bg-secondary transition-all focus:outline-none focus:ring-1 focus:ring-brand/40"
            aria-label={t('sprint.detail.close')}
          >
            <XIcon className="size-4" />
          </button>
        </header>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-border/50 shrink-0">
          {/* Priority — editable */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-border/60 bg-secondary text-xs text-low hover:text-high hover:border-border transition-all focus:outline-none focus:ring-1 focus:ring-brand/40">
                {issue.priority ? (
                  <PriorityBadge priority={issue.priority} showLabel />
                ) : (
                  <span>{t('sprint.detail.noPriority')}</span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onPriorityChange(null)}>
                <span className="text-low">
                  {t('sprint.detail.noPriority')}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {PRIORITIES.map((p) => (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => onPriorityChange(p)}
                  className={issue.priority === p ? 'bg-secondary' : ''}
                >
                  <PriorityBadge priority={p} showLabel />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Labels */}
          {issue.labels.map((label) => (
            <IssueLabelChip key={label.name} label={label} />
          ))}

          {/* Worker */}
          {workers.length > 0 && (
            <WorkerDisplay workers={workers} issue={issue} />
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {issue.body ? (
            <pre className="text-sm text-high whitespace-pre-wrap break-words font-sans leading-relaxed">
              {issue.body}
            </pre>
          ) : (
            <p className="text-sm text-low italic">
              {t('sprint.detail.noBody')}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}

function WorkerDisplay({
  workers,
  issue,
}: {
  workers: Worker[];
  issue: RepoIssue;
}) {
  const { t } = useTranslation('common');
  const activeWorker = workers.find(
    (w) => w.active_workspace_id != null && issue.number != null
  );

  if (!activeWorker) return null;

  return (
    <span
      className="inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-border/50 bg-secondary text-xs text-low"
      title={t('sprint.detail.assignedTo', { worker: activeWorker.name })}
    >
      <span
        className="h-2 w-2 rounded-full bg-brand animate-pulse shrink-0"
        aria-hidden="true"
      />
      <span aria-hidden="true">{activeWorker.emoji}</span>
      <span className="truncate max-w-[8rem]">{activeWorker.name}</span>
    </span>
  );
}
