import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { InputField } from '@vibe/ui/components/InputField';
import { workspacesApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';

interface WorkspaceSearchSidebarProps {
  rootPath: string;
  onOpenFile: (path: string, line: number) => void;
}

interface SearchHit {
  path: string;
  line: number;
  preview: string;
}

function relativePath(path: string, rootPath: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith(`${rootPath}/`)
    ? normalized.slice(rootPath.length + 1)
    : normalized;
}

/**
 * Content search over the workspace worktree (case-insensitive substring,
 * backend-side). Results are grouped by file; clicking a hit opens the file
 * at that line in the embedded editor.
 */
export function WorkspaceSearchSidebar({
  rootPath,
  onOpenFile,
}: WorkspaceSearchSidebarProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const enabled = debouncedQuery.length >= 2;
  const { data: hits, isFetching } = useQuery({
    queryKey: ['editor-search', rootPath, debouncedQuery],
    queryFn: () => workspacesApi.searchEditorContent(rootPath, debouncedQuery),
    enabled,
    staleTime: 10_000,
  });

  const groups = useMemo(() => {
    const byFile = new Map<string, SearchHit[]>();
    for (const hit of hits ?? []) {
      const list = byFile.get(hit.path);
      if (list) list.push(hit);
      else byFile.set(hit.path, [hit]);
    }
    return [...byFile.entries()];
  }, [hits]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-base py-half">
        <InputField
          variant="search"
          value={query}
          onChange={setQuery}
          placeholder={t('workspaces.explorer.searchPlaceholder', {
            defaultValue: 'Search in files…',
          })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {!enabled ? (
          <div className="px-3 py-2 text-xs text-low">
            {t('workspaces.explorer.searchHint', {
              defaultValue: 'Type at least 2 characters to search.',
            })}
          </div>
        ) : isFetching && !hits ? (
          <div className="px-3 py-2 text-xs text-low">
            {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-2 text-xs text-low">
            {t('workspaces.explorer.searchNoResults', {
              defaultValue: 'No results.',
            })}
          </div>
        ) : (
          groups.map(([path, fileHits]) => (
            <div key={path} className="mb-1">
              <div
                className="flex h-[22px] items-center gap-1 px-2 text-xs text-high"
                title={path}
              >
                <FileText
                  size={13}
                  strokeWidth={1.75}
                  className="flex-none text-low"
                />
                <span className="truncate">
                  {relativePath(path, rootPath)}
                </span>
                <span className="flex-none text-low">{fileHits.length}</span>
              </div>
              {fileHits.map((hit, index) => (
                <button
                  key={`${hit.line}-${index}`}
                  type="button"
                  onClick={() => onOpenFile(hit.path, hit.line)}
                  className={cn(
                    'flex h-[22px] w-full min-w-0 items-center gap-2 pl-7 pr-2 text-left text-xs',
                    'text-normal hover:bg-secondary cursor-pointer'
                  )}
                >
                  <span className="flex-none text-low">{hit.line}</span>
                  <span className="truncate">{hit.preview}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
