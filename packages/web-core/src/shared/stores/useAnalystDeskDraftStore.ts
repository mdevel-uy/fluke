import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Scope drafts by repoId so switching repos never leaks a request text between
// them. The sentinel covers the brief window before a repo is selected (e.g.
// on first load) so typing during that window is not silently dropped.
const NO_REPO_SCOPE = '__no-repo__';

interface AnalystDeskDraftState {
  draftsByRepoId: Record<string, string>;
  setDraft: (repoId: string | null, prompt: string) => void;
  clearDraft: (repoId: string | null) => void;
}

export const useAnalystDeskDraftStore = create<AnalystDeskDraftState>()(
  persist(
    (set) => ({
      draftsByRepoId: {},
      setDraft: (repoId, prompt) =>
        set((state) => {
          const key = repoId ?? NO_REPO_SCOPE;
          const next = { ...state.draftsByRepoId };
          if (prompt.length === 0) {
            if (!(key in next)) return state;
            delete next[key];
          } else if (next[key] === prompt) {
            return state;
          } else {
            next[key] = prompt;
          }
          return { draftsByRepoId: next };
        }),
      clearDraft: (repoId) =>
        set((state) => {
          const key = repoId ?? NO_REPO_SCOPE;
          if (!(key in state.draftsByRepoId)) return state;
          const next = { ...state.draftsByRepoId };
          delete next[key];
          return { draftsByRepoId: next };
        }),
    }),
    {
      name: 'analyst-desk-drafts',
      partialize: (state) => ({ draftsByRepoId: state.draftsByRepoId }),
    }
  )
);

/**
 * Analyst Desk request draft, scoped by repoId, persisted in localStorage.
 * The setter mirrors `useState<string>` semantics so callers can drop it in
 * as a replacement.
 */
export function useAnalystDeskDraft(
  repoId: string | null
): [string, (value: string) => void] {
  const key = repoId ?? NO_REPO_SCOPE;
  const prompt = useAnalystDeskDraftStore(
    (state) => state.draftsByRepoId[key] ?? ''
  );
  const setDraft = useAnalystDeskDraftStore((state) => state.setDraft);
  const setPrompt = useCallback(
    (value: string) => setDraft(repoId, value),
    [repoId, setDraft]
  );
  return [prompt, setPrompt];
}
