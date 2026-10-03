import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which milestone bands of the Plan view are collapsed (#664). Stored by
 * milestone name, so a milestone that appears later starts expanded even
 * when every other band is collapsed.
 *
 * `visible` is the list of bands currently on screen; the header's
 * "Colapsar todas / Expandir todas" works on it. It is not persisted.
 */
type State = {
  collapsed: string[];
  visible: string[];
  toggle: (milestone: string) => void;
  setVisible: (milestones: string[]) => void;
  collapseAll: () => void;
  expandAll: () => void;
};

export const usePlanCollapseStore = create<State>()(
  persist(
    (set) => ({
      collapsed: [],
      visible: [],
      toggle: (milestone) =>
        set((s) => ({
          collapsed: s.collapsed.includes(milestone)
            ? s.collapsed.filter((m) => m !== milestone)
            : [...s.collapsed, milestone],
        })),
      setVisible: (milestones) => set({ visible: milestones }),
      collapseAll: () =>
        set((s) => ({
          collapsed: [...new Set([...s.collapsed, ...s.visible])],
        })),
      expandAll: () =>
        set((s) => ({
          collapsed: s.collapsed.filter((m) => !s.visible.includes(m)),
        })),
    }),
    {
      name: 'issues-plan-collapsed',
      partialize: (state) => ({ collapsed: state.collapsed }),
    }
  )
);

/** True when every band on screen is collapsed (drives the header label). */
export const selectAllCollapsed = (s: State) =>
  s.visible.length > 0 && s.visible.every((m) => s.collapsed.includes(m));
