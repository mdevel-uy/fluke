import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Drafts are isolated per repo so switching repos does not surface a prompt
// meant for a different codebase. The `NO_REPO_KEY` sentinel covers the brief
// window before a repo is selected (or when none exist yet).
const NO_REPO_KEY = '__no_repo__';

type State = {
  draftsByRepo: Record<string, string>;
  setDraft: (repoId: string | null, prompt: string) => void;
  clearDraft: (repoId: string | null) => void;
};

function keyFor(repoId: string | null): string {
  return repoId ?? NO_REPO_KEY;
}

export const useAnalystDeskDraftStore = create<State>()(
  persist(
    (set) => ({
      draftsByRepo: {},
      setDraft: (repoId, prompt) =>
        set((state) => {
          const key = keyFor(repoId);
          if (prompt.length === 0) {
            if (!(key in state.draftsByRepo)) return state;
            const { [key]: _removed, ...rest } = state.draftsByRepo;
            return { draftsByRepo: rest };
          }
          if (state.draftsByRepo[key] === prompt) return state;
          return {
            draftsByRepo: { ...state.draftsByRepo, [key]: prompt },
          };
        }),
      clearDraft: (repoId) =>
        set((state) => {
          const key = keyFor(repoId);
          if (!(key in state.draftsByRepo)) return state;
          const { [key]: _removed, ...rest } = state.draftsByRepo;
          return { draftsByRepo: rest };
        }),
    }),
    {
      name: 'analyst-desk-draft',
      partialize: (state) => ({ draftsByRepo: state.draftsByRepo }),
    }
  )
);

export function useAnalystDeskDraft(repoId: string | null): string {
  return useAnalystDeskDraftStore(
    useCallback((state) => state.draftsByRepo[keyFor(repoId)] ?? '', [repoId])
  );
}
