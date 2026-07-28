import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { DirectoryEntry } from 'shared/types';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { fileSystemApi, workspacesApi } from '@/shared/lib/api';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import {
  useWorkspaceEditorFiles,
  useWorkspaceEditorStore,
} from '@/shared/stores/useWorkspaceEditorStore';
import { cn } from '@/shared/lib/utils';

interface WorkspaceExplorerSidebarContainerProps {
  workspaceId: string;
}

/** Entries a code explorer should not surface. */
const HIDDEN_ENTRIES = new Set(['.git']);

function sortEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return [...entries]
    .filter((e) => !HIDDEN_ENTRIES.has(e.name))
    .sort((a, b) => {
      if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

/**
 * File explorer for the selected workspace's worktree, shown in the shell
 * sidebar when the rail's Editor item is active. Clicking a file opens it in
 * the embedded editor tab via the bridge extension — the vscode iframe stays
 * editor-only, this tree is the explorer.
 */
export function WorkspaceExplorerSidebarContainer({
  workspaceId,
}: WorkspaceExplorerSidebarContainerProps) {
  const { t } = useTranslation('common');
  const openWorkspaceViewTab = useUiPreferencesStore(
    (s) => s.openWorkspaceViewTab
  );

  const { data: pathInfo, isLoading: isRootLoading } = useQuery({
    queryKey: ['editor-path', 'explorer-root', workspaceId],
    queryFn: () => workspacesApi.getEditorPath(workspaceId),
    staleTime: Infinity,
  });
  const rootPath = pathInfo?.workspace_path;

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, DirectoryEntry[]>
  >({});
  const { activePath: activeFile } = useWorkspaceEditorFiles(workspaceId);

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const response = await fileSystemApi.list(dirPath);
      setEntriesByDir((current) => ({
        ...current,
        [dirPath]: sortEntries(response.entries),
      }));
    } catch (error) {
      console.error('Failed to list directory', dirPath, error);
      setEntriesByDir((current) => ({ ...current, [dirPath]: [] }));
    }
  }, []);

  const { data: rootEntries } = useQuery({
    queryKey: ['explorer-dir', workspaceId, rootPath],
    queryFn: async () => {
      const response = await fileSystemApi.list(rootPath);
      return sortEntries(response.entries);
    },
    enabled: !!rootPath,
    staleTime: 30_000,
  });

  const toggleDir = useCallback(
    (entry: DirectoryEntry) => {
      const dirPath = String(entry.path);
      setExpandedDirs((current) => {
        const next = new Set(current);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });
      if (!entriesByDir[dirPath]) {
        void loadDir(dirPath);
      }
    },
    [entriesByDir, loadDir]
  );

  const openFile = useCallback(
    (entry: DirectoryEntry) => {
      const filePath = String(entry.path);
      useWorkspaceEditorStore.getState().openFile(workspaceId, filePath);
      openWorkspaceViewTab(workspaceId, 'editor');
    },
    [openWorkspaceViewTab, workspaceId]
  );

  const renderEntries = (entries: DirectoryEntry[], depth: number) =>
    entries.map((entry) => {
      const entryPath = String(entry.path);
      const isExpanded = entry.is_directory && expandedDirs.has(entryPath);
      const children = isExpanded ? entriesByDir[entryPath] : undefined;

      return (
        <div key={entryPath}>
          <button
            type="button"
            onClick={() =>
              entry.is_directory ? toggleDir(entry) : openFile(entry)
            }
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            className={cn(
              'flex h-[22px] w-full min-w-0 items-center gap-1 pr-2 text-left text-xs cursor-pointer',
              activeFile === entryPath
                ? 'bg-sel text-high'
                : 'text-normal hover:bg-secondary'
            )}
          >
            {entry.is_directory ? (
              <>
                {isExpanded ? (
                  <ChevronDown size={13} strokeWidth={1.75} className="flex-none" />
                ) : (
                  <ChevronRight size={13} strokeWidth={1.75} className="flex-none" />
                )}
                {isExpanded ? (
                  <FolderOpen size={14} strokeWidth={1.75} className="flex-none text-low" />
                ) : (
                  <Folder size={14} strokeWidth={1.75} className="flex-none text-low" />
                )}
              </>
            ) : (
              <FileText
                size={14}
                strokeWidth={1.75}
                className="ml-[13px] flex-none text-low"
              />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && children && renderEntries(children, depth + 1)}
          {isExpanded && !children && (
            <div
              style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
              className="h-[22px] flex items-center text-xs text-low"
            >
              {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('workspaces.explorer.title', { defaultValue: 'Explorer' })}
          collapsible={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 pt-1">
        {isRootLoading || !rootEntries ? (
          <div className="px-3 py-2 text-xs text-low">
            {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
          </div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-low">
            {t('workspaces.explorer.empty', { defaultValue: 'Empty folder' })}
          </div>
        ) : (
          renderEntries(rootEntries, 0)
        )}
      </div>
    </div>
  );
}
