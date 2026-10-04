// Widths of the mission tab bar (spec #648): a tab is flex 1 1 0 between
// 96px and 160px, tabs are 2px apart (gap-0.5) and the overflow button is
// 44px (w-11).
export const TAB_MIN = 96;
export const TAB_GAP = 2;
export const OVERFLOW_W = 44;

/**
 * Which open tabs fit loose in the bar and which are only in the dropdown.
 * Stable opening order; if the active tab doesn't fit it takes the last
 * visible slot and the others don't move. At least one tab is visible.
 *
 * `width` is the measured zone that holds the strip and the overflow
 * button, so it doesn't change when the button appears (no oscillation).
 */
export function layoutTabs(
  ids: string[],
  active: string,
  width: number
): { visible: string[]; hidden: string[] } {
  const fit = (w: number) => Math.floor((w + TAB_GAP) / (TAB_MIN + TAB_GAP));
  if (fit(width) >= ids.length) return { visible: ids, hidden: [] };
  const k = Math.max(1, fit(width - OVERFLOW_W - TAB_GAP));
  let visible = ids.slice(0, k);
  if (ids.includes(active) && !visible.includes(active))
    visible = [...ids.slice(0, k - 1), active];
  return { visible, hidden: ids.filter((id) => !visible.includes(id)) };
}
