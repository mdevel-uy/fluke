import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, GitCommitHorizontal, Lock } from 'lucide-react';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  AsideSection,
  Kv,
} from '@/shared/components/ui-new/aside/primitives';
import { PERSIST_KEYS } from '@/shared/stores/useUiPreferencesStore';
import {
  useWorkspaceEditorFiles,
  useWorkspaceEditorStore,
} from '@/shared/stores/useWorkspaceEditorStore';
import { useDiffPaths } from '@/shared/stores/useWorkspaceDiffStore';
import { workspacesApi } from '@/shared/lib/api';
import {
  isCommitDiffPath,
  isCommitScopedPath,
  parseCommitScopedPath,
} from '@/shared/lib/commitFilePath';
import { cn } from '@/shared/lib/utils';

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path;
}

interface EditorAsideProps {
  workspaceId: string;
  /** Only identity bits are needed — accepts any workspace shape. */
  workspace: { branch: string; name?: string | null } | undefined;
}

/**
 * Aside for the Editor view (own identity — NOT the workspace
 * master-detail): says what code the editor is showing (live worktree vs a
 * read-only commit snapshot), lists the open files and the worktree's
 * changed files as quick jumps.
 */
export function EditorAside({ workspaceId, workspace }: EditorAsideProps) {
  const { t } = useTranslation('common');
  const { openPaths, activePath } = useWorkspaceEditorFiles(workspaceId);
  const diffPaths = useDiffPaths();

  const { data: pathInfo } = useQuery({
    queryKey: ['editor-path', 'explorer-root', workspaceId],
    queryFn: () => workspacesApi.getEditorPath(workspaceId),
    staleTime: Infinity,
  });
  const rootPath = pathInfo?.workspace_path?.replace(/\\/g, '/');

  const activeCommitRef = activePath ? parseCommitScopedPath(activePath) : null;

  const displayPath = (path: string): string => {
    const commitRef = parseCommitScopedPath(path);
    if (commitRef) return commitRef.path;
    const normalized = path.replace(/\\/g, '/');
    return rootPath && normalized.startsWith(`${rootPath}/`)
      ? normalized.slice(rootPath.length + 1)
      : normalized;
  };

  const changedFiles = useMemo(() => [...diffPaths].sort(), [diffPaths]);

  const openFileAbsolute = (relPath: string) => {
    if (!rootPath) return;
    useWorkspaceEditorStore
      .getState()
      .openFile(workspaceId, `${rootPath}/${relPath}`);
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('workspaces.editorAside.title', { defaultValue: 'Editor' })}
          collapsible={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* What am I looking at — the self-explanatory bit. */}
        <AsideSection
          persistKey={PERSIST_KEYS.asideEditorSource}
          title={t('workspaces.editorAside.source', {
            defaultValue: 'Viewing',
          })}
        >
          {activeCommitRef ? (
            <>
              <div className="mx-3.5 mb-1.5 flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                <Lock className="h-3 w-3 flex-none" strokeWidth={2} />
                {t('workspaces.editorAside.commitNote', {
                  defaultValue:
                    'Snapshot of commit {{oid}} — read-only, the worktree is untouched.',
                  oid: activeCommitRef.oid.slice(0, 7),
                })}
              </div>
              <Kv
                k={t('workspaces.editorAside.commit', {
                  defaultValue: 'Commit',
                })}
                v={activeCommitRef.oid.slice(0, 7)}
                mono
              />
            </>
          ) : (
            <>
              <div className="mx-3.5 mb-1.5 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-normal">
                {t('workspaces.editorAside.worktreeNote', {
                  defaultValue:
                    "Live worktree of this workspace — saving writes to the worker's working copy.",
                })}
              </div>
              {workspace && (
                <Kv
                  k={t('workspaces.editorAside.branch', {
                    defaultValue: 'Branch',
                  })}
                  v={workspace.branch}
                  mono
                />
              )}
            </>
          )}
          {workspace && (
            <Kv
              k={t('workspaces.editorAside.workspace', {
                defaultValue: 'Workspace',
              })}
              v={workspace.name ?? workspace.branch}
            />
          )}
        </AsideSection>

        <AsideSection
          persistKey={PERSIST_KEYS.asideEditorOpenFiles}
          title={t('workspaces.editorAside.openFiles', {
            defaultValue: 'Open files',
          })}
          count={openPaths.length || undefined}
        >
          {openPaths.length === 0 ? (
            <div className="px-3.5 py-1 text-xs text-low">
              {t('workspaces.editorAside.noOpenFiles', {
                defaultValue: 'No files open — pick one in the Explorer.',
              })}
            </div>
          ) : (
            openPaths.map((path) => {
              const isActive = path === activePath;
              const isSnapshot = isCommitScopedPath(path);
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() =>
                    useWorkspaceEditorStore
                      .getState()
                      .setActiveFile(workspaceId, path)
                  }
                  title={displayPath(path)}
                  className={cn(
                    'flex h-[22px] w-full cursor-pointer items-center gap-2 px-3.5 text-left text-sm',
                    isActive
                      ? 'bg-sel text-high'
                      : 'text-normal hover:bg-secondary'
                  )}
                >
                  {isSnapshot ? (
                    <GitCommitHorizontal
                      className="h-3.5 w-3.5 flex-none text-warning"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <FileText
                      className="h-3.5 w-3.5 flex-none text-low"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-code">
                    {basename(path)}
                  </span>
                  {isSnapshot && (
                    <span className="flex-none font-mono text-[10px] text-warning">
                      {isCommitDiffPath(path) ? 'diff@' : '@'}
                      {parseCommitScopedPath(path)?.oid.slice(0, 7)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </AsideSection>

        <AsideSection
          persistKey={PERSIST_KEYS.asideEditorChanges}
          title={t('workspaces.editorAside.changedFiles', {
            defaultValue: 'Changed in worktree',
          })}
          count={changedFiles.length || undefined}
        >
          {changedFiles.length === 0 ? (
            <div className="px-3.5 py-1 text-xs text-low">
              {t('workspaces.editorAside.noChanges', {
                defaultValue: 'Working tree clean.',
              })}
            </div>
          ) : (
            changedFiles.map((relPath) => (
              <button
                key={relPath}
                type="button"
                onClick={() => openFileAbsolute(relPath)}
                title={relPath}
                className="flex h-[22px] w-full cursor-pointer items-center gap-2 px-3.5 text-left text-sm text-normal hover:bg-secondary"
              >
                <span
                  className="h-[6px] w-[6px] flex-none rounded-full bg-warning"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-mono text-code">
                  {relPath}
                </span>
              </button>
            ))
          )}
        </AsideSection>
      </div>
    </div>
  );
}
