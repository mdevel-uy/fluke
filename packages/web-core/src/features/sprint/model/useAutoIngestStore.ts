import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type State = {
  autoIngest: boolean;
  setAutoIngest: (enabled: boolean) => void;
};

export const useAutoIngestStore = create<State>()(
  persist(
    (set) => ({
      autoIngest: true,
      setAutoIngest: (enabled) => set({ autoIngest: enabled }),
    }),
    {
      name: 'kanban-auto-ingest',
      partialize: (state) => ({ autoIngest: state.autoIngest }),
    }
  )
);
