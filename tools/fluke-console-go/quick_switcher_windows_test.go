package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestQuickSwitchPreservesEditorsAndNeverStartsWork(t *testing.T) {
	d, err := newDemo()
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	m := d.app
	m.repo, m.home, m.view, m.pane = m.state.Projects[0], false, 1, 1
	m.chatDraft[m.repo] = "unfinished brief"
	m.openConfig()
	m.draft[1] = "unfinished executable"
	send := func(msg tea.Msg) {
		t.Helper()
		if _, cmd := m.Update(msg); cmd != nil {
			t.Fatal("navigation must not start commands")
		}
	}
	send(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	send(tea.PasteMsg{Content: "pulso CLAUDE"})
	items := m.switchTargets()
	if len(items) != 1 || items[0].label != "Alertas sin duplicados" {
		t.Fatal("multi-term search", items)
	}
	send(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.switcher != nil || !m.config || m.draft[1] != "unfinished executable" || m.chatDraft[m.repo] != "unfinished brief" {
		t.Fatal("cancel changed editor or draft")
	}
	send(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	send(tea.PasteMsg{Content: "pulso CLAUDE"})
	send(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.repo != m.state.Projects[2] || m.view != 2 || m.config || m.switcher != nil || m.terminals.Windows[m.terminals.FocusedWindow].ID != items[0].taskID || m.terminals.Mode != windowMode {
		t.Fatal("wrong live worker selected")
	}
	// Completed and vanished sessions must open their task instead of restarting.
	for _, query := range []string{"Catálogo móvil", "Alertas sin duplicados"} {
		delete(m.sessions, items[0].taskID)
		send(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
		send(tea.PasteMsg{Content: query})
		send(tea.KeyPressMsg{Code: tea.KeyEnter})
		if m.view != 1 || m.pane != 0 || m.projectTasks()[m.selected].Title != query || m.preparing {
			t.Fatal("closed worker did not open its task")
		}
	}
	send(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	send(tea.PasteMsg{Content: "fluke Turnos"})
	send(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.repo != m.state.Projects[1] || m.view != 1 || m.pane != 1 {
		t.Fatal("project did not open Fluke's chat")
	}
}

func TestQuickSwitchInputMouseAndLayout(t *testing.T) {
	d, err := newDemo()
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	m := d.app
	m.width, m.height = 140, 40
	bar := ansi.Strip(m.tabs())
	// The shell header only carries the palette button; the legacy bar also has Ctrl+P.
	label := "[Ctrl+P]"
	if m.shellMode() {
		label = "[Alt+K]"
	}
	originX, originY := m.navOrigin()
	buttonX := originX + ansi.StringWidth(bar[:strings.Index(bar, label)]) + 1
	m.Update(tea.MouseClickMsg{X: buttonX, Y: originY, Button: tea.MouseLeft})
	if m.switcher == nil {
		t.Fatal("header button did not open switcher")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	for _, size := range [][2]int{{140, 40}, {80, 30}, {44, 24}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.globalKey("ctrl+p")
		m.Update(tea.PasteMsg{Content: "does-not-exist"})
		m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
		if m.switcher == nil || len(m.switchTargets()) != 0 {
			t.Fatal("empty search opened a target")
		}
		m.Update(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
		for _, r := range "móvil" {
			m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
		}
		m.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
		if m.switcher.query != "móvi" {
			t.Fatal("Unicode backspace corrupted query", m.switcher.query)
		}
		m.Update(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
		for range 30 {
			m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
		}
		view := ansi.Strip(m.View().Content)
		if m.switcher.selected != 10 {
			t.Fatal("selection not clamped")
		}
		if len(strings.Split(view, "\n")) != size[1] {
			t.Fatal("vertical overflow")
		}
		for _, line := range strings.Split(view, "\n") {
			if ansi.StringWidth(line) > size[0] {
				t.Fatal("horizontal overflow")
			}
		}
		m.Update(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
		m.Update(tea.PasteMsg{Content: "fluke Turnos"})
		m.Update(tea.MouseClickMsg{X: 5, Y: m.headerRows() + 6, Button: tea.MouseLeft})
		if m.switcher != nil || m.repo != m.state.Projects[1] || m.pane != 1 {
			t.Fatal("mouse opened wrong target")
		}
	}
}

func TestSpanishMetricsSeparatesTokensAndCost(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	view := ansi.Strip(metricsContent(projectMetrics{Tokens: 100, CostUSD: 0.1, UsageRuns: 1, CostRuns: 1, Runs: 1}, 100))
	if !strings.Contains(view, "\nUSD reportados:") {
		t.Fatal("usage amounts run together", view)
	}
}
