import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { workspacesApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import type { FleetBranch } from '../model/useFleetBranches';

type StagingStateData = Awaited<
  ReturnType<typeof workspacesApi.getStagingState>
>;
type StagingFile = StagingStateData['files'][number];
type StagingHunk = StagingFile['staged_hunks'][number];

const STATUS_BADGE: Record<StagingFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

function Checkbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="h-[13px] w-[13px] flex-none cursor-pointer accent-brand disabled:cursor-not-allowed"
    />
  );
}

function HunkBlock({
  hunk,
  staged,
  busy,
  onToggle,
}: {
  hunk: StagingHunk;
  staged: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="mx-3 mb-1.5 overflow-hidden rounded border border-border">
      <div className="flex h-6 items-center gap-2 bg-md-surface-container-low px-2">
        <Checkbox
          checked={staged}
          disabled={busy}
          onChange={onToggle}
          label={`Stage hunk ${hunk.header}`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-low">
          {hunk.header}
        </span>
        <span
          className={cn(
            'flex-none text-[10px] font-medium uppercase tracking-wider',
            staged ? 'text-brand-on-surface' : 'text-low'
          )}
        >
          {staged
            ? t('sourceControl.staging.staged', { defaultValue: 'staged' })
            : t('sourceControl.staging.worktree', { defaultValue: 'worktree' })}
        </span>
      </div>
      <div className="overflow-x-auto py-0.5">
        {hunk.lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              'whitespace-pre px-2 font-mono text-[11px] leading-[17px]',
              line.startsWith('+')
                ? 'bg-success/10 text-success-foreground'
                : line.startsWith('-')
                  ? 'bg-error/10 text-error'
                  : 'text-normal'
            )}
          >
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}

interface StagingViewProps {
  branch: FleetBranch;
  repoId: string;
}

/**
 * SHELL-SPEC R38: selective staging for the selected branch — checkbox per
 * file and per hunk (file checkbox goes indeterminate on mixed hunks),
 * sticky footer with message + "Commit staged". Unchecked changes stay in
 * the worktree so the worker can keep going.
 */
export function StagingView({ branch, repoId }: StagingViewProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const workspaceId = branch.workspace.id;
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['staging', workspaceId, repoId],
    queryFn: () => workspacesApi.getStagingState(workspaceId, repoId),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['staging', workspaceId, repoId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['branchStatus', workspaceId],
    });
  };

  const stageMutation = useMutation({
    mutationFn: (input: { path?: string; patch?: string; unstage: boolean }) =>
      input.unstage
        ? workspacesApi.unstageChanges(workspaceId, {
            repo_id: repoId,
            path: input.path,
            patch: input.patch,
          })
        : workspacesApi.stageChanges(workspaceId, {
            repo_id: repoId,
            path: input.path,
            patch: input.patch,
          }),
    onSettled: invalidate,
  });

  const commitMutation = useMutation({
    mutationFn: () =>
      workspacesApi.commitStaged(workspaceId, {
        repo_id: repoId,
        message,
      }),
    onSuccess: () => setMessage(''),
    onSettled: invalidate,
  });

  const busy = stageMutation.isPending || commitMutation.isPending;
  const files = useMemo(() => data?.files ?? [], [data]);

  const stagedSummary = useMemo(() => {
    let fileCount = 0;
    let added = 0;
    let removed = 0;
    for (const file of files) {
      if (!file.has_staged_changes) continue;
      fileCount += 1;
      for (const hunk of file.staged_hunks) {
        added += hunk.added;
        removed += hunk.removed;
      }
    }
    return { fileCount, added, removed };
  }, [files]);

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-low">
        {t('sourceControl.staging.loading', {
          defaultValue: 'Reading the index…',
        })}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-low">
        {t('sourceControl.staging.clean', {
          defaultValue: 'Working tree clean — nothing to stage on this branch.',
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.map((file) => {
          const fullyStaged =
            file.has_staged_changes && !file.has_unstaged_changes;
          const mixed = file.has_staged_changes && file.has_unstaged_changes;
          const hasHunks =
            file.staged_hunks.length > 0 || file.unstaged_hunks.length > 0;
          const isExpanded = expanded[file.path] ?? false;
          const delta = [...file.staged_hunks, ...file.unstaged_hunks].reduce(
            (acc, hunk) => ({
              added: acc.added + hunk.added,
              removed: acc.removed + hunk.removed,
            }),
            { added: 0, removed: 0 }
          );

          return (
            <div key={file.path}>
              <div
                role={hasHunks ? 'button' : undefined}
                onClick={
                  hasHunks
                    ? () =>
                        setExpanded((prev) => ({
                          ...prev,
                          [file.path]: !isExpanded,
                        }))
                    : undefined
                }
                className={cn(
                  'flex h-[26px] items-center gap-2 px-3 text-sm',
                  hasHunks && 'cursor-pointer hover:bg-secondary/60'
                )}
              >
                <Checkbox
                  checked={fullyStaged || mixed}
                  indeterminate={mixed}
                  disabled={busy}
                  onChange={() =>
                    stageMutation.mutate({
                      path: file.path,
                      unstage: fullyStaged,
                    })
                  }
                  label={`Stage ${file.path}`}
                />
                {hasHunks ? (
                  isExpanded ? (
                    <ChevronDown className="h-3 w-3 flex-none text-low" />
                  ) : (
                    <ChevronRight className="h-3 w-3 flex-none text-low" />
                  )
                ) : (
                  <FileText
                    className="h-3.5 w-3.5 flex-none text-low"
                    strokeWidth={1.75}
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-code text-high">
                  {file.path}
                </span>
                {(delta.added > 0 || delta.removed > 0) && (
                  <span className="flex-none font-mono text-[11px]">
                    <span className="text-success">+{delta.added}</span>{' '}
                    <span className="text-error">−{delta.removed}</span>
                  </span>
                )}
                <span
                  className={cn(
                    'flex-none font-mono text-[11px] font-semibold',
                    file.status === 'deleted'
                      ? 'text-error'
                      : file.status === 'untracked' || file.status === 'added'
                        ? 'text-success'
                        : 'text-warning'
                  )}
                >
                  {STATUS_BADGE[file.status] ?? 'M'}
                </span>
              </div>
              {isExpanded && (
                <div className="pb-1">
                  {file.staged_hunks.map((hunk, index) => (
                    <HunkBlock
                      key={`staged-${index}`}
                      hunk={hunk}
                      staged
                      busy={busy}
                      onToggle={() =>
                        stageMutation.mutate({
                          patch: hunk.patch,
                          unstage: true,
                        })
                      }
                    />
                  ))}
                  {file.unstaged_hunks.map((hunk, index) => (
                    <HunkBlock
                      key={`unstaged-${index}`}
                      hunk={hunk}
                      staged={false}
                      busy={busy}
                      onToggle={() =>
                        stageMutation.mutate({
                          patch: hunk.patch,
                          unstage: false,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="px-3 py-2 text-xs text-low">
          {t('sourceControl.staging.hint', {
            defaultValue:
              'Unchecked changes stay in the worktree — the worker can keep working on them.',
          })}
        </div>
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-md-outline-variant bg-md-surface-container-low px-3 py-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('sourceControl.staging.messagePlaceholder', {
            defaultValue: 'feat: commit message…',
          })}
          className="h-7 min-w-0 flex-1 rounded-[5px] border border-border-strong bg-panel px-2 text-sm text-high placeholder:text-low focus:outline-none focus:border-brand-on-surface"
        />
        <button
          type="button"
          disabled={
            busy || stagedSummary.fileCount === 0 || message.trim() === ''
          }
          onClick={() => commitMutation.mutate()}
          className={cn(
            'h-7 flex-none rounded-[5px] bg-brand px-3 text-sm font-medium text-on-brand',
            'hover:bg-brand-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {commitMutation.isPending
            ? t('sourceControl.staging.committing', {
                defaultValue: 'Committing…',
              })
            : stagedSummary.fileCount === 0
              ? t('sourceControl.staging.nothingStaged', {
                  defaultValue: 'Nothing staged',
                })
              : t('sourceControl.staging.commitButton', {
                  defaultValue:
                    'Commit staged · {{count}} files (+{{added}} −{{removed}})',
                  count: stagedSummary.fileCount,
                  added: stagedSummary.added,
                  removed: stagedSummary.removed,
                })}
        </button>
      </div>
    </div>
  );
}
