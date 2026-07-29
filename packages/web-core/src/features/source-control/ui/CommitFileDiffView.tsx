import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { repoApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/**
 * Parse a unified patch into GitHub-style rows with old/new line numbers.
 * Hunk headers become `meta` rows; file headers are dropped (the tab
 * already names the file).
 */
function parsePatch(patch: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      inHunk = true;
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    } else {
      rows.push({
        kind: 'ctx',
        oldNo: oldNo++,
        newNo: newNo++,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }
  return rows;
}

interface CommitFileDiffViewProps {
  repoId: string;
  oid: string;
  path: string;
}

/**
 * GitHub-style unified diff of one file in a commit: gutter with old/new
 * line numbers, green/red tinted rows, gray hunk separators. Rendered as an
 * in-page tab of the Source control section.
 */
export function CommitFileDiffView({
  repoId,
  oid,
  path,
}: CommitFileDiffViewProps) {
  const { t } = useTranslation('common');

  const { data, isLoading } = useQuery({
    queryKey: ['repo-commit-file-diff', repoId, oid, path],
    queryFn: () => repoApi.getCommitFileDiff(repoId, oid, path),
    staleTime: Infinity,
  });

  const rows = useMemo(() => parsePatch(data?.patch ?? ''), [data]);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const row of rows) {
      if (row.kind === 'add') add += 1;
      else if (row.kind === 'del') del += 1;
    }
    return { add, del };
  }, [rows]);

  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-low">
        {t('sourceControl.diff.loading', { defaultValue: 'Loading diff…' })}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-low">
        {t('sourceControl.diff.empty', {
          defaultValue: 'No textual changes in this file (binary or rename).',
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* File header, GitHub-style. */}
      <div className="flex h-9 flex-none items-center gap-2 border-b border-md-outline-variant bg-md-surface-container-low px-3">
        <FileText className="h-3.5 w-3.5 flex-none text-low" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-mono text-code text-high">
          {path}
        </span>
        <span className="flex-none font-mono text-[11px]">
          <span className="text-success">+{stats.add}</span>{' '}
          <span className="text-error">−{stats.del}</span>
        </span>
        <span className="flex-none rounded border border-border px-1 font-mono text-[10px] leading-4 text-low">
          @{oid.slice(0, 7)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[20px]">
          <tbody>
            {rows.map((row, index) =>
              row.kind === 'meta' ? (
                <tr key={index}>
                  <td
                    colSpan={3}
                    className="bg-secondary/60 px-3 py-0.5 text-[11px] text-low"
                  >
                    {row.text}
                  </td>
                </tr>
              ) : (
                <tr
                  key={index}
                  className={cn(
                    row.kind === 'add' && 'bg-success/10',
                    row.kind === 'del' && 'bg-error/10'
                  )}
                >
                  <td
                    className={cn(
                      'w-[46px] min-w-[46px] select-none border-r border-border px-2 text-right align-top text-[11px] text-low',
                      row.kind === 'add' && 'bg-success/10',
                      row.kind === 'del' && 'bg-error/15'
                    )}
                  >
                    {row.oldNo ?? ''}
                  </td>
                  <td
                    className={cn(
                      'w-[46px] min-w-[46px] select-none border-r border-border px-2 text-right align-top text-[11px] text-low',
                      row.kind === 'add' && 'bg-success/15',
                      row.kind === 'del' && 'bg-error/10'
                    )}
                  >
                    {row.newNo ?? ''}
                  </td>
                  <td className="whitespace-pre px-3 align-top text-normal">
                    <span
                      className={cn(
                        'select-none pr-2',
                        row.kind === 'add'
                          ? 'text-success'
                          : row.kind === 'del'
                            ? 'text-error'
                            : 'text-transparent'
                      )}
                    >
                      {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
                    </span>
                    {row.text}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
