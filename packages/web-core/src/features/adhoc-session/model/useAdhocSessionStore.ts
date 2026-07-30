import { create } from 'zustand';

// In-memory only: the ad-hoc panel state does not survive reloads on purpose
// (session-scoped, per issue #300). Add persistence later if UX asks for it.
type State = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

export const useAdhocSessionStore = create<State>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
