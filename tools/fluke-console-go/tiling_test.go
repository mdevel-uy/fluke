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

func TestTilingStacksFullWidthBands(t *testing.T) {
	for _, tc := range []struct{ w, h, n int }{{160, 34, 3}, {100, 34, 2}, {100, 34, 4}} {
		m := tileTestManager(t, tc.w, tc.h, tc.n)
		y := 0
		for i, w := range m.Windows {
			if w.x != 0 || w.w != tc.w {
				t.Fatalf("%+v: window %d does not use the full width: x=%d w=%d", tc, i, w.x, w.w)
			}
			if w.y != y {
				t.Fatalf("%+v: window %d starts at %d, want %d (stacked, no gap)", tc, i, w.y, y)
			}
			y += w.h
		}
		if y != tc.h {
			t.Fatalf("%+v: bands cover %d of %d rows", tc, y, tc.h)
		}
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

func TestTilingAddsAColumnBeforeCollapsingToOneWindow(t *testing.T) {
	// Six bands in 30 rows would be 5 rows tall: two columns of three keep them readable.
	m := tileTestManager(t, 100, 30, 6)
	if m.singleWindow() {
		t.Fatal("six sessions should still be tiled")
	}
	if m.Windows[0].w != 50 || m.Windows[1].x != 50 || m.Windows[0].h != 10 {
		t.Fatalf("%dx%d at %d,%d / %d,%d", m.Windows[0].w, m.Windows[0].h, m.Windows[0].x, m.Windows[0].y, m.Windows[1].x, m.Windows[1].y)
	}
	// Too many even for that: one window at a time, as before.
	if m = tileTestManager(t, 100, 30, 14); !m.singleWindow() {
		t.Fatal("fourteen sessions cannot be tiled readably")
	}
}
