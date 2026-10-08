package main

import (
	tea "charm.land/bubbletea/v2"
	"strings"
	"testing"
	"time"
)

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
