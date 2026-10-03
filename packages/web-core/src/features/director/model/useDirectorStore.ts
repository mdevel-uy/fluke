import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Global state of the Director bubble ("Fluke" in the UI). Lives outside any
// page so the conversation and the selected mission survive navigation and
// repo changes; persisted so a reload keeps the same view.

// Full screen is a route (/fluke), not a view of the floating assistant.
export type DirectorView = 'bubble' | 'panel';

/** Tab of the panel: a mission id, or the global missions list. */
export const MISSIONS_TAB = 'missions';

interface DirectorState {
  view: DirectorView;
  /** Panel anchored as a column in the shell's right aside. */
  pinned: boolean;
  activeTab: string;
  /** Mission tabs open in the panel (ids), most recent last. */
  openMissionIds: string[];
  /** Notices the user dismissed, keyed by `${missionId}:${reason}`. */
  dismissed: string[];
  toggle: () => void;
  setView: (view: DirectorView) => void;
  setPinned: (pinned: boolean) => void;
  openMission: (missionId: string) => void;
  closeMissionTab: (missionId: string) => void;
  setActiveTab: (tab: string) => void;
  dismiss: (key: string) => void;
}

export const useDirectorStore = create<DirectorState>()(
  persist(
    (set) => ({
      view: 'bubble',
      pinned: false,
      activeTab: MISSIONS_TAB,
      openMissionIds: [],
      dismissed: [],
      toggle: () =>
        set((s) => ({ view: s.view === 'bubble' ? 'panel' : 'bubble' })),
      setView: (view) => set({ view }),
      setPinned: (pinned) => set({ pinned }),
      openMission: (missionId) =>
        set((s) => ({
          view: s.view === 'bubble' ? 'panel' : s.view,
          activeTab: missionId,
          openMissionIds: s.openMissionIds.includes(missionId)
            ? s.openMissionIds
            : [...s.openMissionIds, missionId],
        })),
      closeMissionTab: (missionId) =>
        set((s) => ({
          openMissionIds: s.openMissionIds.filter((id) => id !== missionId),
          activeTab: s.activeTab === missionId ? MISSIONS_TAB : s.activeTab,
        })),
      setActiveTab: (activeTab) => set({ activeTab }),
      dismiss: (key) =>
        set((s) => ({ dismissed: [...s.dismissed.slice(-50), key] })),
    }),
    {
      name: 'director',
      version: 1,
      // v0 had an 'expanded' overlay view, now the /fluke page.
      migrate: (state) => {
        const s = state as DirectorState;
        if ((s.view as string) === 'expanded') s.view = 'panel';
        return s;
      },
    }
  )
);
