package main

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/hinshun/vt10x"
)

func TestNativeZoomRestoresFloatingBoundsAndSmallWindowFocus(t *testing.T) {
	m := newWindowManager(120, 30)
	defer m.Cleanup()
	for _, name := range []string{"Worker A", "Worker B"} {
		m.AddWindowIn(t.TempDir(), name, "powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Write-Output 'READY'; Start-Sleep -Seconds 30")
	}
	if len(m.Windows) != 2 {
		t.Fatal(m.lastError)
	}
	m.ToggleTiling()
	w := m.Windows[0]
	w.x, w.y, w.w, w.h = 3, 4, 60, 15
	m.layout()
	m.FocusWindow(0)
	m.beginMouse(tea.Mouse{X: w.x + w.w - 4, Y: w.y + 1, Button: tea.MouseLeft})
	if !m.zoomed || w.w != 120 || w.h != 30 || m.gesture != nil {
		t.Fatal("title maximize failed")
	}
	m.FocusWindow(1)
	if m.Windows[1].w != 120 || strings.Contains(m.View().Content, "Worker A") {
		t.Fatal("zoom did not follow focus")
	}
	m.ToggleZoom()
	if w.x != 3 || w.y != 4 || w.w != 60 || w.h != 15 {
		t.Fatal("floating bounds lost")
	}
	m.ToggleTiling()
	m.Update(tea.WindowSizeMsg{Width: 44, Height: 18})
	if !m.singleWindow() || m.Windows[1].w != 44 {
		t.Fatal("small window tiled unreadable sessions")
	}
	m.FocusWindow(0)
	cols, rows, err := w.pty.Size()
	if err != nil || cols != 42 || rows != 15 {
		t.Fatal("focused PTY did not resize", cols, rows, err)
	}
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	if m.singleWindow() || w.w != 120 {
		t.Fatal("desktop tiling not restored")
	}
}

// Synthetic project data rendered by the actual TUI, distinct from live-agent captures.
func TestMissionControlCaptures(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	repo, other := t.TempDir(), t.TempDir()
	m.state.Projects = []string{repo, other}
	m.state.Tasks = []Task{
		{Repo: repo, Title: "Flujo de registro", Status: "accepted", Metrics: TaskMetrics{Runs: 1, Deliveries: 1, ObservedMS: 185000}},
		{Repo: repo, Title: "Exportar pedidos", Status: "running", AgentState: "blocked", Metrics: TaskMetrics{Runs: 1, ObservedMS: 62000}},
		{Repo: repo, Title: "Vista móvil", Status: "pending", Queued: true},
	}
	m.state.Conversations = map[string][]ConversationMessage{repo: {{Role: "fluke", Text: "El registro está aceptado. Estoy ayudando al worker de exportación a reutilizar el parser existente. Después sigue la vista móvil; podés revisar el registro mientras avanzamos."}}}
	m.state.Decisions = []Decision{{Repo: repo, TaskID: "demo", Question: "¿Reutilizo el parser de pedidos?", Assistance: true}}
	for _, size := range [][2]int{{140, 40}, {80, 30}, {44, 24}} {
		m.width, m.height, m.insights = size[0], size[1], size[0] < 92
		screen := vt10x.New(vt10x.WithSize(size[0], size[1]))
		screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
		captureNativeScreen(t, screen, fmt.Sprintf("go-mission-%d", size[0]))
	}
}

func TestThemeCaptures(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous); applyTheme("") })
	m := projectTestModel(t)
	repo := t.TempDir()
	m.state.Projects = []string{repo}
	m.state.Tasks = []Task{
		{Repo: repo, Title: "Registro de usuarios", Status: "accepted", Metrics: TaskMetrics{Runs: 1, Deliveries: 1, ObservedMS: 185000}},
		{Repo: repo, Title: "Exportar pedidos", Status: "running", AgentState: "blocked", Metrics: TaskMetrics{Runs: 1, ObservedMS: 62000}},
		{Repo: repo, Title: "Vista móvil", Status: "pending", Queued: true},
	}
	m.state.Conversations = map[string][]ConversationMessage{repo: {{Role: "fluke", Text: "El registro está aceptado. Estoy ayudando al worker de exportación; después sigue la vista móvil."}}}
	for i, theme := range consoleThemes {
		m.state.Theme, m.width, m.height, m.config, m.insights = theme.ID, 100, 32, false, false
		screen := vt10x.New(vt10x.WithSize(m.width, m.height))
		screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
		captureNativeScreen(t, screen, "go-theme-"+theme.ID)
		m.openConfig()
		m.configSection, m.themeSelected, m.width, m.height = 2, i, 44, 24
		screen = vt10x.New(vt10x.WithSize(m.width, m.height))
		screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
		captureNativeScreen(t, screen, "go-theme-picker-"+theme.ID)
	}
}

func TestFloatingChatCaptures(t *testing.T) {
	previous := uiLanguage()
	setUILanguage("es")
	t.Cleanup(func() { setUILanguage(previous) })
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.state.Projects = []string{m.repo}
	m.state.Conversations = map[string][]ConversationMessage{m.repo: {{Role: "fluke", Text: "Estoy ayudando al worker de exportación. Podés revisar el plan mientras avanza."}}}
	for _, size := range [][2]int{{140, 40}, {80, 30}, {44, 24}} {
		m.width, m.height = size[0], size[1]
		m.floating = floatingChat{}
		m.openConfig()
		m.configSection = 1
		m.toggleFloatingChat()
		m.chatDraft[m.repo] = "Revisemos los próximos pasos"
		screen := vt10x.New(vt10x.WithSize(size[0], size[1]))
		screen.Write([]byte(strings.ReplaceAll(m.View().Content, "\n", "\r\n")))
		captureNativeScreen(t, screen, fmt.Sprintf("go-floating-chat-%d", size[0]))
	}
}
