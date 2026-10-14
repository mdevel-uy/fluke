package main

import (
	tea "charm.land/bubbletea/v2"
	"github.com/hinshun/vt10x"
	"strings"
	"testing"
	"time"
)

func TestFloatingChatKeepsUncoveredTerminalCaret(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.home = false
	m.view = 2
	m.width, m.height = 140, 40
	m.terminals.Update(tea.WindowSizeMsg{Width: 140, Height: m.workspaceHeight()})
	m.terminals.AddWindowIn(t.TempDir(), "Worker", "powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	if len(m.terminals.Windows) != 1 {
		t.Fatal(m.terminals.lastError)
	}
	m.terminals.Mode = terminalMode
	m.toggleFloatingChat()
	m.floating.bounds = rectangle{80, 0, 60, 20}
	m.floating.focused = false
	if m.View().Cursor == nil {
		t.Fatal("unfocused chat hid uncovered worker caret")
	}
	m.floating.bounds.x = 0
	if m.View().Cursor != nil {
		t.Fatal("covered worker caret leaked above chat")
	}
	m.floating.bounds.x = 80
	m.floating.focused = true
	if m.View().Cursor != nil {
		t.Fatal("chat focus left terminal caret visible")
	}
}

func TestPinnedWindowWinsPaintingAndMouseWhileTyping(t *testing.T) {
	m := newWindowManager(120, 30)
	defer m.Cleanup()
	for _, name := range []string{"Fluke", "Worker"} {
		m.AddWindowIn(t.TempDir(), name, "powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	}
	if len(m.Windows) != 2 {
		t.Fatal(m.lastError)
	}
	m.ToggleTiling()
	for _, w := range m.Windows {
		w.x, w.y, w.w, w.h = 10, 3, 60, 18
	}
	m.Windows[1].x, m.Windows[1].y, m.Windows[1].w, m.Windows[1].h = 0, 0, 85, 25
	m.layout()
	m.FocusWindow(0)
	m.TogglePin()
	m.FocusWindow(1)
	if m.hit(20, 8) != 0 || m.windowOrder()[1] != 0 {
		t.Fatal("pinned Fluke was covered by focused worker")
	}
	screen := vt10x.New(vt10x.WithSize(120, 30))
	screen.Write([]byte(strings.ReplaceAll(themeCanvas(m.View().Content), "\n", "\r\n")))
	if screen.Cell(65, 4).Char != '[' || screen.Cell(69, 20).Char != '┘' {
		t.Fatal("window controls wrapped or border was clipped")
	}
	captureNativeScreen(t, screen, "go-pinned-window")
	m.Mode = terminalMode
	m.beginMouse(tea.Mouse{X: 30, Y: 4, Button: tea.MouseLeft})
	m.moveMouse(tea.Mouse{X: 40, Y: 6, Button: tea.MouseLeft})
	m.endMouse()
	if m.Windows[0].x != 20 || m.Windows[0].y != 5 || m.Mode != windowMode {
		t.Fatal("cannot drag while typing")
	}
	w := m.Windows[0]
	m.beginMouse(tea.Mouse{X: w.x + w.w - 8, Y: w.y + 1, Button: tea.MouseLeft})
	if w.pinned || m.gesture != nil {
		t.Fatal("unpin button started drag")
	}
	m.beginMouse(tea.Mouse{X: w.x + w.w - 1, Y: w.y + 1, Button: tea.MouseLeft})
	if m.zoomed || m.gesture == nil || m.gesture.edge != edgeRight {
		t.Fatal("resize edge clicked maximize")
	}
	m.endMouse()
}

func TestMouseMovesResizesAndNeverWritesChromeToPTY(t *testing.T) {
	manager := newWindowManager(120, 30)
	defer manager.Cleanup()
	manager.AddWindowIn(t.TempDir(), "Worker", "powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Write-Output 'WINDOW_READY'; Start-Sleep -Seconds 30")
	if len(manager.Windows) != 1 {
		t.Fatal(manager.lastError)
	}
	window := manager.Windows[0]
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s := window.screen.String()
		if strings.Contains(s, "WINDOW_READY") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if window.ProcessExited() {
		t.Fatal("PTY exited before mouse interaction")
	}
	manager.ToggleTiling()
	window.w = 70
	window.h = 18
	manager.layout()
	manager.beginMouse(tea.Mouse{X: 12, Y: 1, Button: tea.MouseLeft})
	manager.moveMouse(tea.Mouse{X: 32, Y: 6, Button: tea.MouseLeft})
	manager.endMouse()
	if window.x != 20 || window.y != 5 {
		t.Fatalf("window didn't move: %d,%d", window.x, window.y)
	}
	oldCols, oldRows, _ := window.pty.Size()
	manager.beginMouse(tea.Mouse{X: window.x + window.w - 1, Y: window.y + window.h - 1, Button: tea.MouseLeft})
	manager.moveMouse(tea.Mouse{X: window.x + window.w - 1 + 10, Y: window.y + window.h - 1 + 3, Button: tea.MouseLeft})
	cols, rows, _ := window.pty.Size()
	if cols != oldCols || rows != oldRows {
		t.Fatal("PTY resized during drag")
	}
	manager.endMouse()
	cols, rows, _ = window.pty.Size()
	if cols != window.w-2 || rows != window.h-3 || cols == oldCols {
		t.Fatalf("PTY size not committed: %dx%d", cols, rows)
	}
	manager.beginMouse(tea.Mouse{X: window.x + 2, Y: window.y + 3, Button: tea.MouseLeft})
	if manager.gesture != nil || manager.Mode != terminalMode {
		t.Fatal("content click started a chrome drag")
	}
	manager.beginMouse(tea.Mouse{X: window.x + 4, Y: window.y + 1, Button: tea.MouseLeft})
	manager.moveMouse(tea.Mouse{X: 999, Y: -999, Button: tea.MouseLeft})
	manager.endMouse()
	if window.x < 0 || window.y < 0 || window.x+window.w > 120 || window.y+window.h > 30 {
		t.Fatal("window escaped desktop")
	}
}
