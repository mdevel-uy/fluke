import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Drafts are scoped per repo so switching repos does not leak an unrelated
// half-typed request. When no repo has been picked yet we still want to keep
// what the user is typing (e.g. while the repo list finishes loading), so a
// sentinel bucket is used until a real repo id is available.
const NO_REPO_SCOPE = '__no_repo__';

const scopeFor = (repoId: string | null): string => repoId ?? NO_REPO_SCOPE;

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
          const key = scopeFor(repoId);
          if (prompt === '') {
            if (!(key in state.draftsByRepoId)) return state;
            const { [key]: _removed, ...rest } = state.draftsByRepoId;
            return { draftsByRepoId: rest };
          }
          if (state.draftsByRepoId[key] === prompt) return state;
          return {
            draftsByRepoId: {
              ...state.draftsByRepoId,
              [key]: prompt,
            },
          };
        }),
      clearDraft: (repoId) =>
        set((state) => {
          const key = scopeFor(repoId);
          if (!(key in state.draftsByRepoId)) return state;
          const { [key]: _removed, ...rest } = state.draftsByRepoId;
          return { draftsByRepoId: rest };
        }),
    }),
    {
      name: 'analyst-desk-draft',
      partialize: (state) => ({ draftsByRepoId: state.draftsByRepoId }),
    }
  )
);

export function useAnalystDeskDraft(repoId: string | null): string {
  return useAnalystDeskDraftStore(
    (s) => s.draftsByRepoId[scopeFor(repoId)] ?? ''
  );
}
