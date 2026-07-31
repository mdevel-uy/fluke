import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Drafts written before the user has picked a repo (or when the app is still
// loading the repo list) live under this key so they are not lost on the
// initial render.
const NO_REPO_KEY = '__no_repo__';

type State = {
  drafts: Record<string, string>;
  setDraft: (repoId: string | null, prompt: string) => void;
};

export const useAnalystDeskDraftStore = create<State>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (repoId, prompt) =>
        set((state) => {
          const key = repoId ?? NO_REPO_KEY;
          if (prompt === '') {
            if (!(key in state.drafts)) return state;
            const { [key]: _removed, ...rest } = state.drafts;
            return { drafts: rest };
          }
          if (state.drafts[key] === prompt) return state;
          return { drafts: { ...state.drafts, [key]: prompt } };
        }),
    }),
    {
      name: 'analyst-desk-drafts',
      partialize: (state) => ({ drafts: state.drafts }),
    }
  )
);

/**
 * Read/write the analyst desk instructions draft for a given repo. Drafts are
 * isolated per `repoId` so switching repos shows that repo's own in-progress
 * text. Setting `''` clears the entry so localStorage does not accumulate
 * empty buckets.
 */
export function useAnalystDeskDraft(
  repoId: string | null
): [string, (prompt: string) => void] {
  const key = repoId ?? NO_REPO_KEY;
  const prompt = useAnalystDeskDraftStore((s) => s.drafts[key] ?? '');
  const setDraftAction = useAnalystDeskDraftStore((s) => s.setDraft);
  const setPrompt = useCallback(
    (next: string) => setDraftAction(repoId, next),
    [repoId, setDraftAction]
  );
  return [prompt, setPrompt];
}
