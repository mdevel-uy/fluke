import { describe, it, expect } from 'vitest';
import { layoutTabs, OVERFLOW_W, TAB_GAP, TAB_MIN } from './tabLayout';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe('layoutTabs', () => {
  for (const n of [1, 5, 20])
    for (const width of [150, 250, 1100])
      it(`${n} tabs, ${width}px: fits, active visible`, () => {
        const all = ids(n);
        const active = all[n - 1];
        const { visible, hidden } = layoutTabs(all, active, width);
        expect(visible).toContain(active);
        expect([...visible, ...hidden].sort()).toEqual([...all].sort());
        // A single tab may shrink below its minimum; with more, each one
        // gets it, plus the overflow button when something is hidden.
        if (visible.length > 1) {
          const used =
            visible.length * TAB_MIN +
            (visible.length - 1) * TAB_GAP +
            (hidden.length ? TAB_GAP + OVERFLOW_W : 0);
          expect(used).toBeLessThanOrEqual(width);
        }
      });

  it('keeps the opening order when everything fits', () => {
    expect(layoutTabs(ids(3), 'm1', 1100)).toEqual({
      visible: ['m0', 'm1', 'm2'],
      hidden: [],
    });
  });

  it('puts a hidden active tab in the last visible slot', () => {
    // 300px: two tabs fit once the overflow button is reserved.
    expect(layoutTabs(ids(5), 'm3', 300)).toEqual({
      visible: ['m0', 'm3'],
      hidden: ['m1', 'm2', 'm4'],
    });
  });

  it('shows the first tabs when the Missions tab is active', () => {
    const { visible } = layoutTabs(ids(20), 'missions', 300);
    expect(visible).toEqual(['m0', 'm1']);
  });

  it('shows at least one tab when none fits', () => {
    expect(layoutTabs(ids(5), 'm4', 50).visible).toEqual(['m4']);
  });
});
