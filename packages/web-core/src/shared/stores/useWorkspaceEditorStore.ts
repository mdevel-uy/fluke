import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WorkspaceEditorFiles {
  openPaths: string[];
  activePath: string | null;
}

interface WorkspaceEditorState {
  /** Open files of the embedded editor, per workspace. Persisted. */
  byWorkspace: Record<string, WorkspaceEditorFiles>;
  /** One-shot "reveal this line when the file is shown" request. */
  pendingReveal: { workspaceId: string; path: string; line: number } | null;
  openFile: (workspaceId: string, path: string, line?: number) => void;
  closeFile: (workspaceId: string, path: string) => void;
  /** Close every open file whose path starts with the prefix (deletions). */
  closeFilesUnder: (workspaceId: string, pathPrefix: string) => void;
  /** Rewrite an open file's path after a rename, keeping it open. */
  renameOpenFile: (workspaceId: string, path: string, newPath: string) => void;
  setActiveFile: (workspaceId: string, path: string) => void;
  consumeReveal: () => void;
}

const EMPTY: WorkspaceEditorFiles = { openPaths: [], activePath: null };

export const useWorkspaceEditorStore = create<WorkspaceEditorState>()(
  persist(
    (set) => ({
      byWorkspace: {},
      pendingReveal: null,

      openFile: (workspaceId, path, line) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const openPaths = current.openPaths.includes(path)
            ? current.openPaths
            : [...current.openPaths, path];
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: { openPaths, activePath: path },
            },
            pendingReveal:
              line != null ? { workspaceId, path, line } : state.pendingReveal,
          };
        }),

      closeFile: (workspaceId, path) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const index = current.openPaths.indexOf(path);
          const openPaths = current.openPaths.filter((p) => p !== path);
          const activePath =
            current.activePath === path
              ? (openPaths[Math.min(index, openPaths.length - 1)] ?? null)
              : current.activePath;
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: { openPaths, activePath },
            },
          };
        }),

      closeFilesUnder: (workspaceId, pathPrefix) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const survives = (p: string) =>
            p !== pathPrefix && !p.startsWith(`${pathPrefix}/`);
          const openPaths = current.openPaths.filter(survives);
          const activePath =
            current.activePath && survives(current.activePath)
              ? current.activePath
              : (openPaths[openPaths.length - 1] ?? null);
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: { openPaths, activePath },
            },
          };
        }),

      renameOpenFile: (workspaceId, path, newPath) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          const rewrite = (p: string) =>
            p === path
              ? newPath
              : p.startsWith(`${path}/`)
                ? `${newPath}${p.slice(path.length)}`
                : p;
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: {
                openPaths: current.openPaths.map(rewrite),
                activePath: current.activePath
                  ? rewrite(current.activePath)
                  : null,
              },
            },
          };
        }),

      setActiveFile: (workspaceId, path) =>
        set((state) => {
          const current = state.byWorkspace[workspaceId] ?? EMPTY;
          if (!current.openPaths.includes(path)) return state;
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceId]: { ...current, activePath: path },
            },
          };
        }),

      consumeReveal: () => set({ pendingReveal: null }),
    }),
    {
      name: 'vk-workspace-editor-files',
      partialize: (state) => ({ byWorkspace: state.byWorkspace }),
    }
  )
);

export function useWorkspaceEditorFiles(
  workspaceId: string | undefined
): WorkspaceEditorFiles {
  return useWorkspaceEditorStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY) : EMPTY
  );
}
