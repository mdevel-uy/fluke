import { create } from 'zustand';

// Session-scoped state for the global ad-hoc Claude panel. Kept in memory
// only (not persisted to localStorage) per epic decision — the panel resets
// closed on every page reload while feature scope is still being defined.

interface AdhocPanelState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useAdhocPanelStore = create<AdhocPanelState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
