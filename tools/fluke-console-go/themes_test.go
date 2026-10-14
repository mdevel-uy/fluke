package main

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/hinshun/vt10x"
)

func TestThemesPreviewCancelPersistAndPreserveConfig(t *testing.T) {
	t.Cleanup(func() { applyTheme("") })
	m := projectTestModel(t)
	m.openConfig()
	m.draft[2] = "unsaved-model"
	m.Update(tea.KeyPressMsg{Code: 't', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m.View()
	if m.state.Theme != "" || vtColor(vt10x.DefaultBG, false) != "48;2;23;16;8" {
		t.Fatal("preview did not apply without saving")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m.View()
	if vtColor(vt10x.DefaultBG, false) != "48;2;21;21;30" {
		t.Fatal("cancel did not restore saved theme")
	}
	m.Update(tea.KeyPressMsg{Code: 't', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m.View()
	if m.state.Theme != "paper" || m.draft[2] != "unsaved-model" || m.state.Orchestrator.Model != "" || !m.config {
		t.Fatal("theme save changed agent configuration")
	}
	dir := m.store.dir
	m.store.lock.Close()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	if state.Theme != "paper" {
		t.Fatal("theme not persisted")
	}
	if vtColor(vt10x.Color(1), true) != "38;5;1" {
		t.Fatal("provider ANSI changed")
	}
	applyTheme("unknown-future-theme")
	if themeVTColor(ground, "48") != "48;2;21;21;30" {
		t.Fatal("missing theme fallback")
	}
}

func TestThemeSaveFailureKeepsStoredChoice(t *testing.T) {
	t.Cleanup(func() { applyTheme("") })
	m := projectTestModel(t)
	m.openConfig()
	m.Update(tea.KeyPressMsg{Code: 't', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.store.dir = filepath.Join(file, "unwritable")
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.state.Theme != "" || m.configSection != 2 {
		t.Fatal("failed save committed preview")
	}
}

func TestThemeContrastAndSmallScreen(t *testing.T) {
	t.Cleanup(func() { applyTheme("") })
	luminance := func(hex string) float64 {
		n, _ := strconv.ParseUint(strings.TrimPrefix(hex, "#"), 16, 32)
		result := 0.0
		for i, weight := range []float64{.2126, .7152, .0722} {
			c := float64(n>>uint(16-i*8)&255) / 255
			if c <= .04045 {
				c /= 12.92
			} else {
				c = math.Pow((c+.055)/1.055, 2.4)
			}
			result += weight * c
		}
		return result
	}
	m := projectTestModel(t)
	m.openConfig()
	m.configSection = 2
	for i, theme := range consoleThemes {
		for _, ink := range []string{theme.Foreground, theme.Structure, theme.Focus, theme.Success, theme.Warning, theme.Muted} {
			a, b := luminance(ink), luminance(theme.Background)
			ratio := (max(a, b) + .05) / (min(a, b) + .05)
			if ratio < 4.5 {
				t.Errorf("%s %s contrast %.2f", theme.ID, ink, ratio)
			}
		}
		m.themeSelected = i
		for _, size := range [][2]int{{44, 24}, {80, 30}, {140, 40}} {
			m.width, m.height = size[0], size[1]
			view := m.View().Content
			if strings.Contains(view, "\x1b[m") || strings.Contains(view, "\x1b[0m") {
				t.Fatal("unscoped style reset loses canvas colors")
			}
			if theme.ID != "neon" && strings.Contains(view, "38;2;226;224;236;48;2;21;21;30") {
				t.Fatal("nested style reset leaked the original palette")
			}
			content := ansi.Strip(view)
			for _, name := range []string{"Fluke", "Amber CRT", "Phosphor", "Midnight", "Gentle", "Paper", "Enter", "Esc"} {
				if !strings.Contains(content, name) {
					t.Errorf("%s at %d missing %s", theme.ID, size[0], name)
				}
			}
			for _, line := range strings.Split(content, "\n") {
				if ansi.StringWidth(line) > size[0] {
					t.Fatal("theme overflow")
				}
			}
		}
	}
}
