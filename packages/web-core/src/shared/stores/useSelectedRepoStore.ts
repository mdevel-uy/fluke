import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type State = {
  selectedRepoId: string | null;
  setSelectedRepoId: (repoId: string | null) => void;
};

export const useSelectedRepoStore = create<State>()(
  persist(
    (set) => ({
      selectedRepoId: null,
      setSelectedRepoId: (repoId) => set({ selectedRepoId: repoId }),
    }),
    {
      name: 'selected-repo',
      partialize: (state) => ({ selectedRepoId: state.selectedRepoId }),
    }
  )
);
