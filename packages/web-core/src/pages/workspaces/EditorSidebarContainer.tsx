import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitCommitHorizontal,
  Lock,
} from 'lucide-react';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { repoApi } from '@/shared/lib/api';
import { useRepos } from '@/shared/hooks/useRepos';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useWorkspaceEditorStore } from '@/shared/stores/useWorkspaceEditorStore';
import {
  useEditorSourceStore,
  type EditorCommitSource,
} from '@/shared/stores/useEditorSourceStore';
import {
  COMMIT_BROWSER_WORKSPACE_ID,
  makeCommitFilePath,
} from '@/shared/lib/commitFilePath';
import { WorkspaceExplorerSidebarContainer } from './WorkspaceExplorerSidebarContainer';
import { cn } from '@/shared/lib/utils';

const RECENT_COMMITS = 40;

/**
 * Read-only lazy tree over a commit's snapshot (GET /commits/{oid}/tree).
 * Opening a file loads it as a `git:` snapshot buffer in the editor.
 */
function CommitTree({
  source,
  onOpenFile,
}: {
  source: EditorCommitSource;
  onOpenFile: ((relPath: string) => void) | null;
}) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, { name: string; is_directory: boolean }[]>
  >({});

  const { data: rootEntries } = useQuery({
    queryKey: ['commit-tree', source.repoId, source.oid, ''],
    queryFn: () => repoApi.getCommitTree(source.repoId, source.oid, ''),
    staleTime: Infinity,
  });

  const toggleDir = async (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!entriesByDir[path]) {
      try {
        const entries = await repoApi.getCommitTree(
          source.repoId,
          source.oid,
          path
        );
        setEntriesByDir((prev) => ({ ...prev, [path]: entries }));
      } catch (error) {
        console.error('Failed to list commit tree', path, error);
      }
    }
  };

  const renderEntries = (
    entries: { name: string; is_directory: boolean }[],
    parentPath: string,
    depth: number
  ): React.ReactNode =>
    entries.map((entry) => {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const indent = { paddingLeft: 16 + depth * 14 };
      if (entry.is_directory) {
        const isOpen = expanded.has(path);
        return (
          <div key={path}>
            <button
              type="button"
              onClick={() => void toggleDir(path)}
              style={indent}
              className="flex h-[22px] w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-sm text-normal hover:bg-secondary"
            >
              {isOpen ? (
                <ChevronDown className="h-3 w-3 flex-none text-low" />
              ) : (
                <ChevronRight className="h-3 w-3 flex-none text-low" />
              )}
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
            {isOpen &&
              entriesByDir[path] &&
              renderEntries(entriesByDir[path], path, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={path}
          type="button"
          onClick={onOpenFile ? () => onOpenFile(path) : undefined}
          title={
            onOpenFile
              ? path
              : t('workspaces.editorSidebar.needsWorkspace', {
                  defaultValue:
                    'Opening snapshot files needs an active workspace.',
                })
          }
          style={indent}
          className={cn(
            'flex h-[22px] w-full items-center gap-2 pr-2 text-left text-sm text-normal',
            onOpenFile
              ? 'cursor-pointer hover:bg-secondary'
              : 'cursor-not-allowed opacity-60'
          )}
        >
          <FileText
            className="h-3.5 w-3.5 flex-none text-low"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-code">
            {entry.name}
          </span>
        </button>
      );
    });

  return (
    <SidebarSection
      persistKey="editor-sidebar-commit-files"
      title={t('workspaces.editorSidebar.snapshotFiles', {
        defaultValue: 'Files @ {{oid}}',
        oid: source.oid.slice(0, 7),
      })}
    >
      <div className="mx-1.5 mb-1 flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
        <Lock className="h-3 w-3 flex-none" strokeWidth={2} />
        {t('workspaces.editorSidebar.readOnly', {
          defaultValue: 'Read-only snapshot',
        })}
      </div>
      {!rootEntries ? (
        <div className="px-3 py-2 text-xs text-low">
          {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
        </div>
      ) : (
        renderEntries(rootEntries, '', 0)
      )}
    </SidebarSection>
  );
}

/**
 * The Editor rail item's OWN sidebar: pick what code to look at — a
 * workspace's live worktree or a commit snapshot — and browse its files
 * below. Replaces the old behavior of falling back to the workspaces list.
 */
export function EditorSidebarContainer({
  workspaceId,
}: {
  workspaceId?: string;
}) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const { activeWorkspaces } = useWorkspaceContext();
  const commitSource = useEditorSourceStore((s) => s.commitSource);
  const setCommitSource = useEditorSourceStore((s) => s.setCommitSource);

  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const { repos } = useRepos();
  const selectedRepo = useMemo(() => {
    if (storedRepoId) {
      const match = repos.find((r) => r.id === storedRepoId);
      if (match) return match;
    }
    return repos[0] ?? null;
  }, [storedRepoId, repos]);
  const baseBranch = selectedRepo?.default_target_branch ?? null;

  const { data: graph } = useQuery({
    queryKey: [
      'editor-recent-commits',
      selectedRepo?.id,
      baseBranch,
      RECENT_COMMITS,
    ],
    queryFn: () =>
      repoApi.getGraph(selectedRepo!.id, baseBranch!, [], RECENT_COMMITS),
    enabled: !!selectedRepo && !!baseBranch,
    staleTime: 30_000,
  });

  // Snapshot files always open: a real workspace hosts the tab when routed,
  // otherwise the sentinel host renders the editor on the landing.
  const openSnapshotFile = commitSource
    ? (relPath: string) => {
        const host = workspaceId ?? COMMIT_BROWSER_WORKSPACE_ID;
        useWorkspaceEditorStore
          .getState()
          .openFile(
            host,
            makeCommitFilePath({
              repoId: commitSource.repoId,
              oid: commitSource.oid,
              path: relPath,
            })
          );
        if (workspaceId) {
          useUiPreferencesStore
            .getState()
            .openWorkspaceViewTab(workspaceId, 'editor');
        }
      }
    : null;

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('workspaces.editorSidebar.title', {
            defaultValue: 'Editor',
          })}
          collapsible={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <SidebarSection
          persistKey="editor-sidebar-workspaces"
          title={t('workspaces.editorSidebar.workspaces', {
            defaultValue: 'Workspaces',
          })}
          count={activeWorkspaces.length || undefined}
        >
          {activeWorkspaces.length === 0 ? (
            <div className="px-3.5 py-1 text-xs text-low">
              {t('workspaces.editorSidebar.noWorkspaces', {
                defaultValue: 'No active workspaces.',
              })}
            </div>
          ) : (
            activeWorkspaces.map((ws) => (
              <SidebarRow
                key={ws.id}
                selected={!commitSource && ws.id === workspaceId}
                onClick={() => {
                  setCommitSource(null);
                  if (ws.id !== workspaceId) {
                    appNavigation.goToWorkspace(ws.id);
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-code">
                  {ws.branch}
                </span>
              </SidebarRow>
            ))
          )}
        </SidebarSection>

        <SidebarSection
          persistKey="editor-sidebar-commits"
          title={t('workspaces.editorSidebar.commits', {
            defaultValue: 'Commits',
          })}
          defaultOpen={false}
        >
          {!graph ? (
            <div className="px-3.5 py-1 text-xs text-low">
              {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
            </div>
          ) : (
            graph.commits.map((commit) => (
              <SidebarRow
                key={commit.oid}
                selected={commitSource?.oid === commit.oid}
                onClick={() =>
                  setCommitSource(
                    commitSource?.oid === commit.oid
                      ? null
                      : {
                          repoId: selectedRepo!.id,
                          oid: commit.oid,
                          summary: commit.summary,
                        }
                  )
                }
              >
                <GitCommitHorizontal
                  className="h-3 w-3 flex-none text-low"
                  strokeWidth={1.75}
                />
                <span className="flex-none font-mono text-[11px] text-low">
                  {commit.short_oid}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {commit.summary}
                </span>
              </SidebarRow>
            ))
          )}
        </SidebarSection>

        {commitSource ? (
          <CommitTree source={commitSource} onOpenFile={openSnapshotFile} />
        ) : workspaceId ? (
          <div className="flex min-h-[200px] flex-col">
            <WorkspaceExplorerSidebarContainer workspaceId={workspaceId} />
          </div>
        ) : (
          <div className="px-3.5 py-2 text-xs text-low">
            {t('workspaces.editorSidebar.pickSource', {
              defaultValue:
                'Pick a workspace or a commit to browse its files.',
            })}
          </div>
        )}
      </div>
    </div>
  );
}
