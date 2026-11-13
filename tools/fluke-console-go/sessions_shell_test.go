package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func sessionsDemo(t *testing.T, w, h int) (*demoModel, *model) {
	t.Helper()
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	d, err := newDemo()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.close)
	d.Update(tea.WindowSizeMsg{Width: w, Height: h})
	d.navigate("f2")
	d.navigate("f3")
	return d, d.app
}

func TestSessionsPanelShowsContextNextToTheTerminal(t *testing.T) {
	_, m := sessionsDemo(t, 140, 40)
	if m.sessionsPanelWidth() == 0 {
		t.Fatal("panel missing at 140 columns")
	}
	lines := strings.Split(ansi.Strip(m.View().Content), "\n")
	if len(lines) != 40 {
		t.Fatalf("%d lines", len(lines))
	}
	for _, l := range lines {
		if ansi.StringWidth(l) > 140 {
			t.Fatalf("overflow %q", l)
		}
	}
	view := strings.Join(lines, "\n")
	for _, want := range []string{"SESIONES", "Checkout e impuestos", "LO ÚLTIMO QUE REPORTÓ", "SALIDA RECIENTE", "TERMINADO CUANDO", "DEMO / SESIÓN SIMULADA"} {
		if !strings.Contains(view, want) {
			t.Fatalf("missing %q\n%s", want, view)
		}
	}
	// The terminal lives in the area right of the panel.
	if got := m.terminals.width; got != 140-m.sessionsPanelWidth() {
		t.Fatalf("terminal width %d", got)
	}
}

func TestSessionsPanelClickFocusesThatSession(t *testing.T) {
	_, m := sessionsDemo(t, 140, 40)
	visible := m.terminals.visibleWindows()
	if len(visible) < 2 {
		t.Fatalf("need two sessions, have %d", len(visible))
	}
	m.View() // builds the click map
	target := -1
	for row, hit := range m.sessionHits {
		if hit.window >= 0 && hit.window != m.terminals.FocusedWindow {
			target = row
			want := hit.window
			m.Update(tea.MouseClickMsg{X: 4, Y: m.headerRows() + target, Button: tea.MouseLeft})
			if m.terminals.FocusedWindow != want {
				t.Fatalf("focused %d, want %d", m.terminals.FocusedWindow, want)
			}
			return
		}
	}
	t.Fatal("no other session in the panel")
}

func TestSessionsKeepFullWidthTerminalsWhenNarrow(t *testing.T) {
	_, m := sessionsDemo(t, 104, 30)
	if m.sessionsPanelWidth() != 0 {
		t.Fatal("narrow terminals keep the terminals at full width")
	}
	if strings.Contains(ansi.Strip(m.View().Content), "SALIDA RECIENTE") {
		t.Fatal("context panel drawn without room")
	}
}
