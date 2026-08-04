import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror, {
  EditorView,
  keymap,
  type Extension,
} from '@uiw/react-codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { FileCode, Lock, X } from 'lucide-react';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import {
  isCommitDiffPath,
  isCommitScopedPath,
  parseCommitDiffPath,
  parseCommitFilePath,
  parseCommitScopedPath,
} from '@/shared/lib/commitFilePath';
import {
  useWorkspaceEditorFiles,
  useWorkspaceEditorStore,
} from '@/shared/stores/useWorkspaceEditorStore';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { cn } from '@/shared/lib/utils';

interface EditorPanelContainerProps {
  workspaceId: string;
  className?: string;
}

interface FileDoc {
  doc: string;
  saved: string;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path;
}

/**
 * Native embedded code editor (CodeMirror) for the workspace worktree.
 * Files are opened from the shell-sidebar explorer
 * (WorkspaceExplorerSidebarContainer → useWorkspaceEditorStore); this panel
 * renders its own file tabs and the editing surface — nothing else.
 */
export function EditorPanelContainer({
  workspaceId,
  className,
}: EditorPanelContainerProps) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const { openPaths, activePath } = useWorkspaceEditorFiles(workspaceId);
  const pendingReveal = useWorkspaceEditorStore((s) => s.pendingReveal);
  const viewRef = useRef<EditorView | null>(null);
  // Bumped when CodeMirror (re)creates its view so the reveal effect reruns
  // once the view actually exists.
  const [viewVersion, setViewVersion] = useState(0);

  // Unsaved buffers survive tab switches; keyed by absolute path.
  const docsRef = useRef(new Map<string, FileDoc>());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [loadedDoc, setLoadedDoc] = useState<{
    path: string;
    doc: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [langExtension, setLangExtension] = useState<Extension | null>(null);

  // Load the active file (from cache when it has been opened before).
  useEffect(() => {
    if (!activePath) {
      setLoadedDoc(null);
      setLoadError(null);
      return;
    }

    const cached = docsRef.current.get(activePath);
    if (cached) {
      setLoadedDoc({ path: activePath, doc: cached.doc });
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setLoadedDoc(null);
    setLoadError(null);
    // Commit snapshots (`git:`) load from the commit tree, diff tabs
    // (`gitdiff:`) load the unified patch; live worktree files from disk.
    const fileRef = parseCommitFilePath(activePath);
    const diffRef = parseCommitDiffPath(activePath);
    const load = diffRef
      ? repoApi
          .getCommitFileDiff(diffRef.repoId, diffRef.oid, diffRef.path)
          .then(({ patch }) => ({ content: patch }))
      : fileRef
        ? repoApi.getCommitFile(fileRef.repoId, fileRef.oid, fileRef.path)
        : workspacesApi.readEditorFile(activePath);
    load
      .then(({ content }) => {
        if (cancelled) return;
        docsRef.current.set(activePath, { doc: content, saved: content });
        setLoadedDoc({ path: activePath, doc: content });
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // Syntax highlighting for the active file, lazily loaded per language.
  // Diff tabs always highlight as unified patches.
  useEffect(() => {
    setLangExtension(null);
    if (!activePath) return;
    const description = LanguageDescription.matchFilename(
      languages,
      isCommitDiffPath(activePath) ? 'changes.diff' : basename(activePath)
    );
    if (!description) return;
    let cancelled = false;
    void description.load().then((support) => {
      if (!cancelled) setLangExtension(support);
    });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // One-shot line reveal (search results open "file at line").
  useEffect(() => {
    if (
      !pendingReveal ||
      pendingReveal.workspaceId !== workspaceId ||
      pendingReveal.path !== activePath ||
      !loadedDoc ||
      loadedDoc.path !== activePath
    ) {
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    const lineNumber = Math.min(
      Math.max(1, pendingReveal.line),
      view.state.doc.lines
    );
    const position = view.state.doc.line(lineNumber).from;
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    });
    view.focus();
    useWorkspaceEditorStore.getState().consumeReveal();
  }, [pendingReveal, workspaceId, activePath, loadedDoc, viewVersion]);

  const markDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((current) => {
      if (current.has(path) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      if (!activePath) return;
      const entry = docsRef.current.get(activePath);
      if (!entry) return;
      entry.doc = value;
      markDirty(activePath, value !== entry.saved);
    },
    [activePath, markDirty]
  );

  const saveFile = useCallback(
    async (path: string) => {
      if (isCommitScopedPath(path)) return;
      const entry = docsRef.current.get(path);
      if (!entry || entry.doc === entry.saved) return;
      const doc = entry.doc;
      try {
        await workspacesApi.saveEditorFile(path, doc);
        entry.saved = doc;
        markDirty(path, entry.doc !== entry.saved);
      } catch (error) {
        console.error('Failed to save file', path, error);
      }
    },
    [markDirty]
  );

  const saveFileRef = useRef(saveFile);
  saveFileRef.current = saveFile;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const saveKeymap = useRef<Extension>(
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          const path =
            useWorkspaceEditorStore.getState().byWorkspace[
              workspaceIdRef.current
            ]?.activePath;
          if (path) void saveFileRef.current(path);
          return true;
        },
      },
    ])
  );

  const closeFile = useCallback(
    (path: string) => {
      docsRef.current.delete(path);
      markDirty(path, false);
      useWorkspaceEditorStore.getState().closeFile(workspaceId, path);
    },
    [workspaceId, markDirty]
  );

  const setActive = useCallback(
    (path: string) => {
      useWorkspaceEditorStore.getState().setActiveFile(workspaceId, path);
    },
    [workspaceId]
  );

  if (openPaths.length === 0) {
    return (
      <div className={className}>
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <FileCode size={28} strokeWidth={1.5} className="text-low" />
          <p className="text-sm text-normal">
            {t('workspaces.editor.emptyTitle', {
              defaultValue: 'No file open',
            })}
          </p>
          <p className="max-w-sm text-xs text-low">
            {t('workspaces.editor.emptyHint', {
              defaultValue:
                'Pick a file in the Explorer sidebar to edit it here.',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* File tabs */}
      <div className="flex h-8 flex-none items-stretch overflow-x-auto border-b border-md-outline-variant bg-md-surface-container-low">
        {openPaths.map((path) => {
          const isActive = path === activePath;
          const isDirty = dirtyPaths.has(path);
          return (
            <div
              key={path}
              className={cn(
                'group/filetab flex flex-none items-center gap-1.5 border-r border-md-outline-variant px-3 text-xs',
                isActive
                  ? 'bg-md-surface-container-lowest text-high'
                  : 'text-low hover:text-normal'
              )}
            >
              <button
                type="button"
                onClick={() => setActive(path)}
                title={path}
                className="flex items-center gap-1.5 focus:outline-none cursor-pointer"
              >
                {basename(path)}
                {isCommitScopedPath(path) && (
                  <span className="flex items-center gap-0.5 font-mono text-[10px] text-low">
                    <Lock size={9} strokeWidth={2} />
                    {isCommitDiffPath(path) ? 'diff@' : '@'}
                    {parseCommitScopedPath(path)?.oid.slice(0, 7)}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => closeFile(path)}
                aria-label={t('workspaces.tabs.close', {
                  defaultValue: 'Close',
                })}
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-sm cursor-pointer -mr-1',
                  isDirty
                    ? 'text-high'
                    : cn(
                        'text-low hover:bg-md-surface-container-high hover:text-high',
                        isActive
                          ? 'visible'
                          : 'invisible group-hover/filetab:visible'
                      )
                )}
              >
                {isDirty ? (
                  <span
                    className="h-2 w-2 rounded-full bg-current"
                    aria-hidden
                  />
                ) : (
                  <X size={11} strokeWidth={2} />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Read-only banner for commit-scoped buffers. */}
      {activePath && isCommitScopedPath(activePath) && (
        <div className="flex h-6 flex-none items-center gap-1.5 border-b border-warning/40 bg-warning/10 px-3 text-[11px] text-warning">
          <Lock size={11} strokeWidth={2} />
          {isCommitDiffPath(activePath)
            ? t('workspaces.editor.commitDiff', {
                defaultValue:
                  'Diff of commit {{oid}} vs its parent — read-only.',
                oid: parseCommitScopedPath(activePath)?.oid.slice(0, 7),
              })
            : t('workspaces.editor.commitSnapshot', {
                defaultValue:
                  'Read-only snapshot of commit {{oid}} — edits are disabled.',
                oid: parseCommitScopedPath(activePath)?.oid.slice(0, 7),
              })}
        </div>
      )}

      {/* Editing surface */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loadError ? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="max-w-md text-xs text-low">{loadError}</p>
          </div>
        ) : !loadedDoc || loadedDoc.path !== activePath ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-low">
              {t('workspaces.explorer.loading', { defaultValue: 'Loading…' })}
            </p>
          </div>
        ) : (
          <CodeMirror
            key={loadedDoc.path}
            value={loadedDoc.doc}
            onChange={handleChange}
            editable={!isCommitScopedPath(loadedDoc.path)}
            readOnly={isCommitScopedPath(loadedDoc.path)}
            onCreateEditor={(view) => {
              viewRef.current = view;
              setViewVersion((v) => v + 1);
            }}
            theme={getResolvedTheme(theme)}
            extensions={
              langExtension
                ? [saveKeymap.current, langExtension]
                : [saveKeymap.current]
            }
            height="100%"
            className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
          />
        )}
      </div>
    </div>
  );
}
