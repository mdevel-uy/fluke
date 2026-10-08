package main

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestNativePTYScrollbackReadsOldOutputAndKeepsInputWorking(t *testing.T) {
	manager := newWindowManager(60, 12)
	defer manager.Cleanup()
	manager.AddWindowIn(t.TempDir(), "History fixture", "powershell.exe", "-NoLogo", "-NoProfile", "-Command", "0..79 | ForEach-Object { Write-Output ('SCROLL_ROW_{0:D3}' -f $_) }; Write-Output 'SCROLL_READY'; $value = Read-Host 'value'; Write-Output ('ECHO_' + $value); Start-Sleep -Seconds 30")
	if len(manager.Windows) != 1 {
		t.Fatal(manager.lastError)
	}
	w := manager.Windows[0]
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if strings.Contains(w.visibleText(), marker) {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("native PTY didn't show %q: %q", marker, w.visibleText())
	}
	wait("SCROLL_READY")
	manager.Update(tea.KeyPressMsg{Code: tea.KeyHome})
	if !strings.Contains(w.visibleText(), "SCROLL_ROW_000") {
		t.Fatalf("native startup burst lost its first rows: %q", w.visibleText())
	}
	manager.Mode = terminalMode
	manager.Update(tea.KeyPressMsg{Code: tea.KeyEnd, Mod: tea.ModShift})
	wait("SCROLL_READY")
	manager.Update(tea.KeyPressMsg{Code: tea.KeyPgUp, Mod: tea.ModShift})
	if w.historyLabel() == "" {
		t.Fatal("Shift+PgUp didn't navigate the native PTY history")
	}
	manager.Update(tea.PasteMsg{Content: "PTY_VALUE"})
	if w.historyLabel() != "" {
		t.Fatal("paste didn't return to live input")
	}
	manager.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	wait("ECHO_PTY_VALUE")
	if w.ProcessExited() {
		t.Fatal("history navigation terminated the owned process")
	}
}
