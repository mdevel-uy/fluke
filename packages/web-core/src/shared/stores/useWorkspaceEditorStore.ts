import { create } from 'zustand';

export interface WorkspaceEditorFiles {
  openPaths: string[];
  activePath: string | null;
}

interface WorkspaceEditorState {
  /** Open files of the embedded editor, per workspace. In-memory only. */
  byWorkspace: Record<string, WorkspaceEditorFiles>;
  openFile: (workspaceId: string, path: string) => void;
  closeFile: (workspaceId: string, path: string) => void;
  setActiveFile: (workspaceId: string, path: string) => void;
}

const EMPTY: WorkspaceEditorFiles = { openPaths: [], activePath: null };

export const useWorkspaceEditorStore = create<WorkspaceEditorState>((set) => ({
  byWorkspace: {},

  openFile: (workspaceId, path) =>
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
}));

export function useWorkspaceEditorFiles(
  workspaceId: string | undefined
): WorkspaceEditorFiles {
  return useWorkspaceEditorStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY) : EMPTY
  );
}
