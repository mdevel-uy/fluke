import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
} from 'lucide-react';
import type { DirectoryEntry } from 'shared/types';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { fileSystemApi, workspacesApi } from '@/shared/lib/api';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useWorkspaceEditorStore } from '@/shared/stores/useWorkspaceEditorStore';
import { useDiffPaths } from '@/shared/stores/useWorkspaceDiffStore';
import { cn } from '@/shared/lib/utils';
import { WorkspaceSearchSidebar } from './WorkspaceSearchSidebar';

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

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

type PendingEdit =
  | { mode: 'create-file' | 'create-dir'; dirPath: string }
  | { mode: 'rename'; path: string; dirPath: string; initialName: string };

/**
 * File explorer for the selected workspace's worktree, shown in the shell
 * sidebar when the rail's Editor item is active. Clicking a file opens it in
 * the embedded editor tab; files with uncommitted changes are tinted.
 */
export function WorkspaceExplorerSidebarContainer({
  workspaceId,
}: WorkspaceExplorerSidebarContainerProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const openWorkspaceViewTab = useUiPreferencesStore(
    (s) => s.openWorkspaceViewTab
  );
  const activeFile = useWorkspaceEditorStore(
    (s) => s.byWorkspace[workspaceId]?.activePath ?? null
  );

  const [view, setView] = useState<'files' | 'search'>('files');

  const { data: pathInfo, isLoading: isRootLoading } = useQuery({
    queryKey: ['editor-path', 'explorer-root', workspaceId],
    queryFn: () => workspacesApi.getEditorPath(workspaceId),
    staleTime: Infinity,
  });
  const rootPath = pathInfo?.workspace_path?.replace(/\\/g, '/');

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, DirectoryEntry[]>
  >({});
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [editValue, setEditValue] = useState('');

  // Uncommitted changes → tint files/dirs (paths from the diff stream are
  // repo-relative; the worktree root prefix makes them absolute).
  const diffPaths = useDiffPaths();
  const changedAbsPaths = useMemo(() => {
    if (!rootPath) return new Set<string>();
    return new Set(
      [...diffPaths].map((rel) => `${rootPath}/${rel.replace(/\\/g, '/')}`)
    );
  }, [diffPaths, rootPath]);
  const isFileChanged = useCallback(
    (abs: string) => changedAbsPaths.has(abs),
    [changedAbsPaths]
  );
  const isDirChanged = useCallback(
    (abs: string) => {
      const prefix = `${abs}/`;
      for (const p of changedAbsPaths) {
        if (p.startsWith(prefix)) return true;
      }
      return false;
    },
    [changedAbsPaths]
  );

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

  const refreshDir = useCallback(
    (dirPath: string) => {
      if (dirPath === rootPath) {
        void queryClient.invalidateQueries({
          queryKey: ['explorer-dir', workspaceId, rootPath],
        });
      } else {
        void loadDir(dirPath);
      }
    },
    [rootPath, queryClient, workspaceId, loadDir]
  );

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
    (path: string, line?: number) => {
      useWorkspaceEditorStore.getState().openFile(workspaceId, path, line);
      openWorkspaceViewTab(workspaceId, 'editor');
    },
    [openWorkspaceViewTab, workspaceId]
  );

  // ── File operations ────────────────────────────────────────────────
  const startCreate = useCallback(
    (mode: 'create-file' | 'create-dir', dirPath: string) => {
      setPendingEdit({ mode, dirPath });
      setEditValue('');
      setExpandedDirs((current) => new Set(current).add(dirPath));
      if (dirPath !== rootPath && !entriesByDir[dirPath]) void loadDir(dirPath);
    },
    [rootPath, entriesByDir, loadDir]
  );

  const startRename = useCallback((entry: DirectoryEntry) => {
    const path = String(entry.path);
    setPendingEdit({
      mode: 'rename',
      path,
      dirPath: parentDir(path),
      initialName: entry.name,
    });
    setEditValue(entry.name);
  }, []);

  const commitEdit = useCallback(async () => {
    const edit = pendingEdit;
    const name = editValue.trim();
    setPendingEdit(null);
    if (!edit || !name || name.includes('/') || name.includes('\\')) return;

    try {
      if (edit.mode === 'rename') {
        if (name === edit.initialName) return;
        const newPath = `${edit.dirPath}/${name}`;
        await workspacesApi.renameEditorEntry(edit.path, newPath);
        useWorkspaceEditorStore
          .getState()
          .renameOpenFile(workspaceId, edit.path, newPath);
        refreshDir(edit.dirPath);
      } else {
        const newPath = `${edit.dirPath}/${name}`;
        await workspacesApi.createEditorEntry(
          newPath,
          edit.mode === 'create-dir'
        );
        refreshDir(edit.dirPath);
        if (edit.mode === 'create-file') openFile(newPath);
      }
    } catch (error) {
      console.error('File operation failed', error);
      await ConfirmDialog.show({
        title: t('workspaces.explorer.opFailedTitle', {
          defaultValue: 'File operation failed',
        }),
        message: error instanceof Error ? error.message : String(error),
        confirmText: 'OK',
        showCancelButton: false,
        variant: 'destructive',
      });
    }
  }, [pendingEdit, editValue, workspaceId, refreshDir, openFile, t]);

  const deleteEntry = useCallback(
    async (entry: DirectoryEntry) => {
      const path = String(entry.path);
      const result = await ConfirmDialog.show({
        title: t('workspaces.explorer.deleteTitle', {
          defaultValue: 'Delete',
        }),
        message: entry.is_directory
          ? t('workspaces.explorer.deleteDirMessage', {
              defaultValue: `Delete the folder "${entry.name}" and everything in it?`,
            })
          : t('workspaces.explorer.deleteFileMessage', {
              defaultValue: `Delete "${entry.name}"?`,
            }),
        confirmText: t('workspaces.explorer.deleteConfirm', {
          defaultValue: 'Delete',
        }),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;

      try {
        await workspacesApi.deleteEditorEntry(path);
        useWorkspaceEditorStore.getState().closeFilesUnder(workspaceId, path);
        refreshDir(parentDir(path));
      } catch (error) {
        console.error('Failed to delete', path, error);
      }
    },
    [workspaceId, refreshDir, t]
  );

  // ── Rendering ──────────────────────────────────────────────────────
  const editInputRow = (depth: number) => (
    <div
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className="flex h-[22px] items-center pr-2"
    >
      <input
        autoFocus
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => void commitEdit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitEdit();
          if (e.key === 'Escape') setPendingEdit(null);
        }}
        className="h-[18px] w-full min-w-0 rounded-sm border border-brand bg-primary px-1 text-xs text-high focus:outline-none"
      />
    </div>
  );

  const entryMenu = (entry: DirectoryEntry) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        className="invisible ml-auto flex h-4 w-4 flex-none items-center justify-center rounded-sm text-low hover:text-high group-hover/exprow:visible cursor-pointer focus:outline-none"
        aria-label={t('workspaces.explorer.entryActions', {
          defaultValue: 'Actions',
        })}
      >
        <MoreHorizontal size={12} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {entry.is_directory && (
          <>
            <DropdownMenuItem
              onClick={() => startCreate('create-file', String(entry.path))}
            >
              {t('workspaces.explorer.newFile', { defaultValue: 'New File' })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => startCreate('create-dir', String(entry.path))}
            >
              {t('workspaces.explorer.newFolder', {
                defaultValue: 'New Folder',
              })}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={() => startRename(entry)}>
          {t('workspaces.explorer.rename', { defaultValue: 'Rename' })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void deleteEntry(entry)}>
          {t('workspaces.explorer.delete', { defaultValue: 'Delete' })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderEntries = (entries: DirectoryEntry[], depth: number) =>
    entries.map((entry) => {
      const entryPath = String(entry.path);
      const isExpanded = entry.is_directory && expandedDirs.has(entryPath);
      const children = isExpanded ? entriesByDir[entryPath] : undefined;
      const isRenaming =
        pendingEdit?.mode === 'rename' && pendingEdit.path === entryPath;
      const changed = entry.is_directory
        ? isDirChanged(entryPath)
        : isFileChanged(entryPath);

      if (isRenaming) {
        return <div key={entryPath}>{editInputRow(depth)}</div>;
      }

      return (
        <div key={entryPath}>
          <div
            role="button"
            tabIndex={0}
            onClick={() =>
              entry.is_directory ? toggleDir(entry) : openFile(entryPath)
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (entry.is_directory) toggleDir(entry);
                else openFile(entryPath);
              }
            }}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            className={cn(
              'group/exprow flex h-[22px] w-full min-w-0 items-center gap-1 pr-2 text-left text-xs cursor-pointer',
              activeFile === entryPath
                ? 'bg-sel text-high'
                : 'text-normal hover:bg-secondary'
            )}
          >
            {entry.is_directory ? (
              <>
                {isExpanded ? (
                  <ChevronDown
                    size={13}
                    strokeWidth={1.75}
                    className="flex-none"
                  />
                ) : (
                  <ChevronRight
                    size={13}
                    strokeWidth={1.75}
                    className="flex-none"
                  />
                )}
                {isExpanded ? (
                  <FolderOpen
                    size={14}
                    strokeWidth={1.75}
                    className="flex-none text-low"
                  />
                ) : (
                  <Folder
                    size={14}
                    strokeWidth={1.75}
                    className="flex-none text-low"
                  />
                )}
              </>
            ) : (
              <FileText
                size={14}
                strokeWidth={1.75}
                className="ml-[13px] flex-none text-low"
              />
            )}
            <span className={cn('truncate', changed && 'text-warning')}>
              {entry.name}
            </span>
            {changed && (
              <span
                className="h-1 w-1 flex-none rounded-full bg-warning"
                aria-hidden
              />
            )}
            {entryMenu(entry)}
          </div>
          {isExpanded &&
            pendingEdit &&
            pendingEdit.mode !== 'rename' &&
            pendingEdit.dirPath === entryPath &&
            editInputRow(depth + 1)}
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
          title={
            view === 'search'
              ? t('workspaces.explorer.searchTitle', {
                  defaultValue: 'Search',
                })
              : t('workspaces.explorer.title', { defaultValue: 'Explorer' })
          }
          collapsible={false}
          actions={
            view === 'search'
              ? [
                  {
                    materialIcon: 'folder_open',
                    onClick: () => setView('files'),
                  },
                ]
              : [
                  { materialIcon: 'search', onClick: () => setView('search') },
                  ...(rootPath
                    ? [
                        {
                          materialIcon: 'note_add',
                          onClick: () => startCreate('create-file', rootPath),
                        },
                        {
                          materialIcon: 'create_new_folder',
                          onClick: () => startCreate('create-dir', rootPath),
                        },
                      ]
                    : []),
                ]
          }
        />
      </div>
      {view === 'search' && rootPath ? (
        <WorkspaceSearchSidebar
          rootPath={rootPath}
          onOpenFile={(path, line) => openFile(path, line)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-3 pt-1">
          {pendingEdit &&
            pendingEdit.mode !== 'rename' &&
            pendingEdit.dirPath === rootPath &&
            editInputRow(0)}
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
      )}
    </div>
  );
}
