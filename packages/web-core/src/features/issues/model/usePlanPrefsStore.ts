import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * How the user arranges the Plan view
 * (design/mockups/fluke-v2/milestone-actions.dc.html): bands or compact
 * rows, starred milestones, the order they dragged them to, and whether the
 * Archived section is open. Stored by milestone name, like the collapsed
 * bands.
 */

export type PlanDensity = 'bands' | 'compact';

type State = {
  density: PlanDensity;
  starred: string[];
  order: string[];
  showArchived: boolean;
  setDensity: (density: PlanDensity) => void;
  toggleStar: (milestone: string) => void;
  setOrder: (order: string[]) => void;
  toggleArchived: () => void;
};

export const usePlanPrefsStore = create<State>()(
  persist(
    (set) => ({
      density: 'bands',
      starred: [],
      order: [],
      showArchived: false,
      setDensity: (density) => set({ density }),
      toggleStar: (milestone) =>
        set((s) => ({
          starred: s.starred.includes(milestone)
            ? s.starred.filter((m) => m !== milestone)
            : [...s.starred, milestone],
        })),
      setOrder: (order) => set({ order }),
      toggleArchived: () => set((s) => ({ showArchived: !s.showArchived })),
    }),
    { name: 'issues-plan-prefs' }
  )
);
