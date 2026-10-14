package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

func tileTestManager(t *testing.T, w, h, n int) *windowManager {
	t.Helper()
	m := newWindowManager(w, h)
	for i := 0; i < n; i++ {
		pty, err := xpty.NewPty(80, 20)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pty.Close() })
		m.Windows = append(m.Windows, &terminalWindow{ID: fmt.Sprintf("w%d", i), Name: fmt.Sprintf("Window %d", i), pty: pty, screen: vt10x.New(vt10x.WithSize(80, 20))})
	}
	m.layout()
	return m
}

func TestTilingAlwaysFillsTheWholeArea(t *testing.T) {
	for _, tc := range []struct{ w, h, n int }{
		{100, 34, 1}, {100, 34, 2}, {100, 34, 3}, {100, 34, 4}, {100, 34, 5},
		{160, 34, 2}, {160, 34, 3}, {160, 34, 4}, {160, 34, 7}, {120, 40, 3},
	} {
		m := tileTestManager(t, tc.w, tc.h, tc.n)
		if m.singleWindow() {
			continue // too many for readable tiles: one window, covered elsewhere
		}
		area := 0
		for _, w := range m.Windows {
			if w.x < 0 || w.y < 0 || w.x+w.w > tc.w || w.y+w.h > tc.h || w.w < 1 || w.h < 1 {
				t.Fatalf("%+v: window %s outside the area: %d,%d %dx%d", tc, w.ID, w.x, w.y, w.w, w.h)
			}
			area += w.w * w.h
		}
		if area != tc.w*tc.h {
			t.Fatalf("%+v: tiles cover %d of %d cells", tc, area, tc.w*tc.h)
		}
	}
}

func TestTilingIsHorizontalFirstAndAShortRowStretches(t *testing.T) {
	// Wide area: three windows side by side in one row.
	m := tileTestManager(t, 160, 34, 3)
	for i, w := range m.Windows {
		if w.y != 0 || w.h != 34 {
			t.Fatalf("window %d is not a full-height column: y=%d h=%d", i, w.y, w.h)
		}
	}
	// Narrow area: two columns, and the third window takes the whole second row.
	m = tileTestManager(t, 100, 34, 3)
	third := m.Windows[2]
	if m.Windows[0].w != 50 || m.Windows[1].w != 50 || third.w != 100 || third.x != 0 || third.y == 0 {
		t.Fatalf("%dx%d %dx%d third=%d,%d %dx%d", m.Windows[0].x, m.Windows[0].w, m.Windows[1].x, m.Windows[1].w, third.x, third.y, third.w, third.h)
	}
}

func TestWindowTitleIsDescribedByTheHost(t *testing.T) {
	m := tileTestManager(t, 120, 30, 2)
	m.titleFor = func(w *terminalWindow) string {
		if w.ID == "w0" {
			return "◐ Checkout · trabajando · codex · 8m 00s"
		}
		return ""
	}
	view := m.View().Content
	if !strings.Contains(view, "Checkout · trabajando · codex") || !strings.Contains(view, "Window 1") {
		t.Fatalf("titles not as described:\n%s", view)
	}
}
