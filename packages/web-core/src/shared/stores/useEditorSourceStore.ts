import { create } from 'zustand';

/**
 * What the embedded editor's sidebar is browsing: `null` = the live
 * worktree of the routed workspace; a commit source switches the file tree
 * (and opened files) to a read-only snapshot of that commit.
 * Session-scoped on purpose — a page reload lands you back on the worktree.
 */
export interface EditorCommitSource {
  repoId: string;
  oid: string;
  /** First line of the commit message, for labels. */
  summary: string;
}

interface EditorSourceState {
  commitSource: EditorCommitSource | null;
  setCommitSource: (source: EditorCommitSource | null) => void;
}

export const useEditorSourceStore = create<EditorSourceState>()((set) => ({
  commitSource: null,
  setCommitSource: (source) => set({ commitSource: source }),
}));
