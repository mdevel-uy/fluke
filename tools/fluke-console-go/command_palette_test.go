package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestCommandPalettePreservesDraftsAndReturnsConnectionCheck(t *testing.T) {
	m := projectTestModel(t)
	m.openConfig()
	m.field = 2
	m.draft[2] = "unsaved-model"
	m.chatDraft[m.repo] = "unsent message"
	draft := m.draft
	m.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModAlt})
	m.Update(tea.PasteMsg{Content: "theme"})
	if targets := m.switchTargets(); len(targets) != 1 || targets[0].action != "theme" {
		t.Fatal("palette must find settings by stable action as well as translated label", targets)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.switcher != nil || !m.config || m.draft != draft || m.chatDraft[m.repo] != "unsent message" {
		t.Fatal("cancel discarded an underlying editor")
	}
	m.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModAlt})
	m.Update(tea.PasteMsg{Content: "connection"})
	// The stable action is shared with the translated label; choose the provider result.
	for i, target := range m.switchTargets() {
		if target.action == "connection" {
			m.switcher.selected = i
			break
		}
	}
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd == nil || !m.providerBusy || m.configSection != 4 || m.switcher != nil {
		t.Fatal("connection navigation lost the asynchronous health check")
	}
	if m.draft != draft || m.state.Orchestrator.Model != "" || m.preparing {
		t.Fatal("opening connection saved a draft or started a session")
	}
	// Browsing read-only sections must not paste into the hidden model field.
	for _, section := range []int{1, 2, 3, 4} {
		m.configSection, m.field = section, 2
		m.Update(tea.PasteMsg{Content: "injected into hidden field"})
		if m.draft != draft {
			t.Fatalf("section %d edited the agent draft", section)
		}
	}
}

func TestCommandPaletteEmptySearchAndModeSwitch(t *testing.T) {
	m := projectTestModel(t)
	m.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModAlt})
	for _, target := range m.switchTargets() {
		if target.action == "f2" || target.action == "f3" || target.action == "f4" {
			t.Fatal("project-only action shown without a project")
		}
	}
	m.Update(tea.PasteMsg{Content: "no-matches-é"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	if m.switcher.query != "no-matches-" {
		t.Fatal("search broke a Unicode character")
	}
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if cmd != nil || m.switcher == nil {
		t.Fatal("empty search executed or closed")
	}
	m.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if m.switcher == nil || m.switcher.commands || m.switcher.query != "" {
		t.Fatal("Ctrl+P did not switch to project search")
	}
	m.Update(tea.KeyPressMsg{Code: 'k', Mod: tea.ModAlt})
	if m.switcher == nil || !m.switcher.commands {
		t.Fatal("Alt+K did not return to commands")
	}
	m.Update(tea.PasteMsg{Content: "ctrl+k"})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.command == nil || *m.command != "" || m.preparing {
		t.Fatal("advanced entry must only open an empty command editor")
	}
}

func TestSettingsTabsMouseKeyboardAndPreviewAtSmallSizes(t *testing.T) {
	previous := uiLanguage()
	t.Cleanup(func() { setUILanguage(previous); applyTheme("") })
	m := projectTestModel(t)
	for _, language := range []string{"en", "es"} {
		setUILanguage(language)
		for _, size := range [][2]int{{44, 24}, {80, 30}, {140, 40}} {
			m.width, m.height = size[0], size[1]
			for _, section := range []int{0, 4, 1, 2, 3} {
				m.openConfig()
				m.draft[2] = "keep-model"
				w := m.width
				if w >= 104 {
					w = w * 55 / 100
				}
				x := 2
				for _, tab := range configTabs(w - 4) {
					if tab.section == section {
						break
					}
					x += ansi.StringWidth(tab.label) + 1
				}
				m.Update(tea.MouseClickMsg{X: x, Y: m.headerRows() + 3, Button: tea.MouseLeft})
				if m.configSection != section || m.draft[2] != "keep-model" {
					t.Fatalf("%s %v: tab %d lost target or draft", language, size, section)
				}
				content := ansi.Strip(m.View().Content)
				if len(strings.Split(content, "\n")) != m.height {
					t.Fatal("settings height overflow")
				}
				for _, line := range strings.Split(content, "\n") {
					if ansi.StringWidth(line) > m.width {
						t.Fatal("settings width overflow")
					}
				}
				if section == 3 && (!strings.Contains(content, "Unicode") || !strings.Contains(content, "Windows Terminal")) {
					t.Fatal("font instructions clipped on a supported screen size")
				}
			}
		}
	}
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: 't', Mod: tea.ModCtrl})
	m.themeSelected = themeIndex("gentle")
	m.View()
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight, Mod: tea.ModCtrl})
	m.View()
	if m.configSection != 3 || m.state.Theme != "" || themeVTColor(ground, "48") != "48;2;21;21;30" {
		t.Fatal("leaving appearance did not discard the uncommitted preview")
	}
}

func TestConnectionSeparatesAvailabilityAndAuthentication(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("en")
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	m.openConfig()
	m.provider = providerHealth{Provider: "codex", Available: true, Message: "CLI found"}
	content := ansi.Strip(m.providerStatusContent(70))
	if !strings.Contains(content, "CLI: available") || !strings.Contains(content, "Account: unverified") {
		t.Fatal("executable availability was mistaken for authentication", content)
	}
	m.provider.AuthKnown, m.provider.Authenticated = true, true
	if !strings.Contains(ansi.Strip(m.providerStatusContent(70)), "Account: authenticated") {
		t.Fatal("verified authentication not visible")
	}
	m.providerBusy = true
	if strings.Contains(ansi.Strip(m.providerStatusContent(70)), "Account: authenticated") {
		t.Fatal("a pending check displayed the old authentication state as current")
	}
}

func TestCommandPaletteShortcutVisibleInNarrowTerminals(t *testing.T) {
	m := projectTestModel(t)
	for _, width := range []int{44, 80} {
		m.width = width
		for _, view := range []int{0, 1, 2, 3} {
			m.view = view
			if !strings.Contains(ansi.Strip(m.footer()), "[Alt+K]") {
				t.Fatalf("palette undiscoverable at width %d, view %d", width, view)
			}
		}
	}
}
