import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Global state of the Director bubble ("Fluke" in the UI). Lives outside any
// page so the conversation and the focused mission survive navigation and
// repo changes; persisted so a reload keeps the same view.

// Full screen is a route (/fluke), not a view of the floating assistant.
export type DirectorView = 'bubble' | 'panel';

/** Missions the panel's dropdown lists: all open ones, or one group. */
export type PickerFilter = 'all' | 'waiting' | 'working';

/** Wire summaries from /api/app-errors/stream; fingerprints are backend-only. */
export interface AppErrorNotice {
  fingerprint: string;
  message: string;
  source: string;
  location: string;
  count: number;
  first_seen: number;
  last_seen: number;
}

interface DirectorState {
  appErrors: AppErrorNotice[];
  errorSession: string | null;
  ignoredErrors: string[];
  setAppErrors: (session: string, errors: AppErrorNotice[]) => void;
  ignoreAppError: (fingerprint: string) => void;
  view: DirectorView;
  /** Panel anchored as a column in the shell's right aside. */
  pinned: boolean;
  /** Mission the panel shows; null falls back to Fluke's general one. */
  focusId: string | null;
  /** Mission list dropped from the panel header; not persisted. */
  picker: PickerFilter | null;
  /** Notices the user dismissed, keyed by `${missionId}:${reason}`. */
  dismissed: string[];
  toggle: () => void;
  setView: (view: DirectorView) => void;
  setPinned: (pinned: boolean) => void;
  /** Focus a mission without opening the panel (rail, /fluke page). */
  focus: (missionId: string) => void;
  /** Focus a mission and open the panel if it was collapsed. */
  openMission: (missionId: string) => void;
  /** Drop the focus if it is on this mission (archived or deleted). */
  unfocus: (missionId: string) => void;
  setPicker: (picker: PickerFilter | null) => void;
  dismiss: (key: string) => void;
}

export const useDirectorStore = create<DirectorState>()(
  persist(
    (set) => ({
      appErrors: [],
      errorSession: null,
      ignoredErrors: [],
      setAppErrors: (errorSession, appErrors) =>
        set((s) => ({
          errorSession,
          appErrors,
          ignoredErrors: s.errorSession === errorSession ? s.ignoredErrors : [],
        })),
      ignoreAppError: (fingerprint) =>
        set((s) => ({
          ignoredErrors: [...new Set([...s.ignoredErrors, fingerprint])],
        })),
      view: 'bubble',
      pinned: false,
      focusId: null,
      picker: null,
      dismissed: [],
      toggle: () =>
        set((s) => ({ view: s.view === 'bubble' ? 'panel' : 'bubble' })),
      setView: (view) => set({ view }),
      setPinned: (pinned) => set({ pinned }),
      focus: (focusId) => set({ focusId, picker: null }),
      openMission: (focusId) =>
        set((s) => ({
          view: s.view === 'bubble' ? 'panel' : s.view,
          focusId,
          picker: null,
        })),
      unfocus: (missionId) =>
        set((s) => (s.focusId === missionId ? { focusId: null } : s)),
      setPicker: (picker) => set({ picker }),
      dismiss: (key) =>
        set((s) => ({ dismissed: [...s.dismissed.slice(-50), key] })),
    }),
    {
      name: 'director',
      partialize: ({ view, pinned, focusId, dismissed }) => ({
        view,
        pinned,
        focusId,
        dismissed,
      }),
      version: 2,
      // v0 had an 'expanded' overlay view, now the /fluke page; v1 had tabs
      // (activeTab + openMissionIds), now a single focus.
      migrate: (state, version) => {
        const s = state as DirectorState & {
          activeTab?: string;
          openMissionIds?: string[];
        };
        if ((s.view as string) === 'expanded') s.view = 'panel';
        if (version < 2) {
          s.focusId =
            s.activeTab && s.activeTab !== 'missions' ? s.activeTab : null;
          delete s.activeTab;
          delete s.openMissionIds;
        }
        return s;
      },
    }
  )
);
