package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestDelayedPasteIsSubmittedAndAcknowledged(t *testing.T) {
	// Mimic a CLI that ignores Enter until 200ms after processing a slow paste.
	script := `$Host.UI.RawUI.WindowTitle = 'Chat fixture'
[Console]::Write('READY')
$first = $true
$lastText = [DateTime]::MinValue
while ($true) {
 $key = [Console]::ReadKey($true)
 if ($key.Key -eq 'Enter') {
  if (((Get-Date) - $lastText).TotalMilliseconds -lt 200) { continue }
  [Console]::Write(' ACCEPTED esc to interrupt')
  Start-Sleep -Seconds 30
  break
 }
 if ($first) { Start-Sleep -Milliseconds 700; $first = $false }
 [Console]::Write($key.KeyChar)
 $lastText = Get-Date
}
`
	for _, mode := range []string{"old-fixed-delay", "confirmed", "ignored-enter"} {
		t.Run(mode, func(t *testing.T) {
			fixture := script
			if mode == "ignored-enter" {
				fixture = strings.Replace(fixture, "if ($key.Key -eq 'Enter') {", "if ($key.Key -eq 'Enter') { continue;", 1)
			}
			dir := t.TempDir()
			path := filepath.Join(dir, "fixture.ps1")
			if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
				t.Fatal(err)
			}
			wm := newWindowManager(120, 30)
			defer wm.Cleanup()
			wm.AddWindowIn(dir, "Fixture", "powershell.exe", "-NoLogo", "-NoProfile", "-File", path)
			if len(wm.Windows) != 1 {
				t.Fatal(wm.lastError)
			}
			w := wm.Windows[0]
			deadline := time.Now().Add(10 * time.Second)
			for !strings.Contains(w.screen.String(), "READY") {
				if time.Now().After(deadline) {
					t.Fatal("fixture startup", w.screen.String())
				}
				time.Sleep(25 * time.Millisecond)
			}
			if mode == "old-fixed-delay" {
				w.writer.Write([]byte("hello"))
				time.Sleep(300 * time.Millisecond)
				w.writer.Write([]byte(terminalEnter()))
				time.Sleep(time.Second)
				if strings.Contains(w.screen.String(), "ACCEPTED") {
					t.Fatal("fixture did not reproduce the old early Enter")
				}
				return
			}
			err := w.sendQueuedChat("claude", "hello")
			if mode == "ignored-enter" {
				if err == nil || !w.userInputPending.Load() {
					t.Fatal("unacknowledged write reported success or allowed retries")
				}
				return
			}
			if err != nil {
				t.Fatal(err, w.screen.String())
			}
			if !strings.Contains(w.screen.String(), "ACCEPTED") {
				t.Fatal("reported delivery without submit acknowledgement")
			}
		})
	}
}

func TestHiddenFlukeDoesNotOccupyWorkerWorkspace(t *testing.T) {
	m := projectTestModel(t)
	m.repo = t.TempDir()
	m.width, m.height = 120, 40
	m.terminals.width, m.terminals.height = 120, 30
	for _, name := range []string{"Internal Fluke", "Worker one", "Worker two"} {
		m.terminals.AddWindowIn(m.repo, name, "powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	}
	if len(m.terminals.Windows) != 3 {
		t.Fatal(m.terminals.lastError)
	}
	m.sessions["fluke:"+m.repo] = m.terminals.Windows[0].ID
	m.globalKey("f3")
	if len(m.terminals.visibleWindows()) != 2 || strings.Contains(m.View().Content, "Internal Fluke") {
		t.Fatal("Fluke leaked into worker view")
	}
	for range 4 {
		m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
		if m.terminals.FocusedWindow == 0 {
			t.Fatal("Tab focused hidden Fluke")
		}
	}
	if m.terminals.Windows[1].h != 30 || m.terminals.Windows[2].h != 30 {
		t.Fatal("hidden Fluke still reserves space")
	}
	m.focus("fluke:" + m.repo)
	if m.terminals.Windows[0].hidden {
		t.Fatal("permission diagnostics inaccessible")
	}
	m.globalKey("f2")
	m.globalKey("f3")
	if !m.terminals.Windows[0].hidden {
		t.Fatal("diagnostics remained in ordinary workspace")
	}
}
