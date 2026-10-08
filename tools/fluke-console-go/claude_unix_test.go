//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// Normally starts without a prompt. FLUKE_TEST_CLAUDE_CHAT=1 also runs one
// small real-model turn in the temporary repository created by this test.
func TestUnixClaudeStartupRemainsResponsive(t *testing.T) {
	cli := os.Getenv("FLUKE_TEST_CLAUDE_STARTUP")
	if cli == "" {
		t.Skip("set FLUKE_TEST_CLAUDE_STARTUP to the local Claude executable")
	}
	repo := testRepo(t)
	manager := newWindowManager(100, 32)
	defer manager.Cleanup()
	liveChat := os.Getenv("FLUKE_TEST_CLAUDE_CHAT") == "1"
	argv := []string{cli}
	if liveChat {
		argv = append(argv, "--model", "opus", "--", "Sin usar herramientas ni modificar archivos, respondé únicamente con el resultado de 1234567 + 7654321.")
	}
	manager.AddWindowIn(repo, "Claude startup", argv...)
	if manager.lastError != nil || len(manager.Windows) != 1 {
		t.Fatal("could not start Claude", manager.lastError)
	}
	window := manager.Windows[0]
	deadline := time.Now().Add(20 * time.Second)
	if liveChat {
		deadline = time.Now().Add(90 * time.Second)
	}
	trusted := false
	for time.Now().Before(deadline) {
		result := make(chan string, 1)
		go func() {
			_, screen := window.agentSignals()
			result <- screen
		}()
		select {
		case screen := <-result:
			if window.ProcessExited() {
				t.Fatal("Claude exited during startup", strings.TrimSpace(screen))
			}
			if strings.TrimSpace(screen) != "" {
				if !liveChat || strings.Contains(screen, "8888888") || strings.Contains(screen, "8,888,888") {
					t.Logf("Local Claude screen:\n%s", strings.TrimSpace(screen))
					return
				}
				if !trusted && claudeTrustPending("claude", screen) && strings.Contains(screen, repo) {
					// Trust only this test's newly created repository, never a user's repo.
					if _, err := window.pty.Write([]byte("\x1b[B")); err != nil {
						t.Fatal(err)
					}
					time.Sleep(300 * time.Millisecond)
					if _, err := window.pty.Write([]byte(terminalEnter())); err != nil {
						t.Fatal(err)
					}
					trusted = true
				}
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Claude output blocked the terminal emulator and UI reads")
		}
		time.Sleep(200 * time.Millisecond)
	}
	_, screen := window.agentSignals()
	t.Fatal("Claude did not reach the expected screen", strings.TrimSpace(screen))
}
