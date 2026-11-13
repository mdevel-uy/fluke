package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeResumeArgumentsAndValidation(t *testing.T) {
	id, err := newNativeSessionID()
	if err != nil || !validNativeSessionID(id) {
		t.Fatalf("UUID generation failed: %s %v", id, err)
	}
	for _, invalid := range []string{"", "last", "named-session", "--last", id + "\n", strings.ReplaceAll(id, "-", "")} {
		if validNativeSessionID(invalid) {
			t.Fatalf("ambiguous session selector accepted: %q", invalid)
		}
	}
	for _, provider := range []string{"codex", "claude"} {
		original := AgentConfig{Provider: provider, Executable: provider, Model: "chosen", Arguments: []string{"--no-alt-screen"}}
		if provider == "claude" {
			original.Arguments = []string{"--allowedTools", "Bash", "Read"}
		}
		config, err := nativeResumeConfig(original, id)
		if err != nil {
			t.Fatal(err)
		}
		argv, err := config.argv()
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(argv, " ")
		if !strings.Contains(joined, "--model chosen") || !strings.Contains(joined, id) {
			t.Fatalf("resume lost exact identity or model: %v", argv)
		}
		if provider == "codex" && (argv[1] != "resume" || argv[2] != id) {
			t.Fatal("Codex ID should precede optional variadic flags")
		}
		if provider == "claude" && !strings.Contains(joined, "--resume "+id) {
			t.Fatal("Claude lacks explicit ID selector")
		}
		if original.Arguments[0] == "resume" || original.Arguments[len(original.Arguments)-1] == id {
			t.Fatal("resume construction mutated saved config arguments")
		}
		for _, forbidden := range []string{"--last", "--resume=another", "--fork-session", "--worktree", "--"} {
			bad := original
			bad.Arguments = []string{forbidden}
			if _, err := nativeResumeConfig(bad, id); err == nil {
				t.Fatalf("%s accepted conflicting selector %s", provider, forbidden)
			}
		}
	}
	config, err := nativeNewClaudeConfig(AgentConfig{Provider: "claude", Executable: "claude", Model: "sonnet"}, id)
	if err != nil || strings.Join(config.Arguments, " ") != "--session-id "+id {
		t.Fatal("Claude first launch did not bind exact UUID", err)
	}
}

func TestVerifyCodexNativeSessionExactIdentity(t *testing.T) {
	home, cwd, runID := t.TempDir(), t.TempDir(), strings.Repeat("a", 32)
	id, err := newNativeSessionID()
	if err != nil {
		t.Fatal(err)
	}
	metaID := id
	meta := func(dir string) string {
		encoded, err := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{"id": metaID, "session_id": metaID, "cwd": dir}})
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	prompt := func(text string) string {
		encoded, err := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "item_completed", "item": map[string]any{"type": "UserMessage", "content": []map[string]string{{"type": "text", "text": text}}}}})
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	dir := filepath.Join(home, "sessions", "2026", "10", "08")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "rollout-2026-10-08T00-00-00-"+id+".jsonl")
	write := func(contents string) {
		t.Helper()
		if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	automatic := `{"type":"response_item","payload":{"role":"user","type":"message","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}` + "\n" + `{"type":"response_item","payload":{"role":"user","type":"message","content":[{"type":"input_text","text":"<environment_context>automatic context</environment_context>"}]}}`
	body := meta(cwd) + "\n" + automatic + "\n" + prompt("Fluke run "+runID+": read the new contract") + "\n"
	write(body)
	// A broken unrelated session must not be opened while verifying this UUID.
	if err := os.WriteFile(filepath.Join(dir, "rollout-other-00000000-0000-4000-8000-000000000001.jsonl"), []byte("private unrelated invalid data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyCodexNativeSession(home, id, cwd, runID); err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]string{"type": "user_message", "message": "Fluke run " + runID}})
	write(meta(cwd) + "\n" + automatic + "\n" + string(legacy) + "\n")
	if err := verifyCodexNativeSession(home, id, cwd, runID); err != nil {
		t.Fatal("legacy human-input event rejected", err)
	}
	// A matching nonce in injected context cannot establish human ownership.
	write(meta(cwd) + "\n" + strings.ReplaceAll(automatic, "# AGENTS.md instructions", runID) + "\n" + prompt("Another session's first prompt") + "\n" + prompt("Fluke run "+runID) + "\n")
	if err := verifyCodexNativeSession(home, id, cwd, runID); err == nil {
		t.Fatal("automatic context or later nonce bypassed first human prompt")
	}
	write(meta(t.TempDir()) + "\n" + prompt("Fluke run "+runID) + "\n")
	if err := verifyCodexNativeSession(home, id, cwd, runID); err == nil {
		t.Fatal("foreign cwd accepted")
	}
	write(meta(cwd) + "\n" + prompt("Another session's first prompt") + "\n" + prompt("Fluke run "+runID) + "\n")
	if err := verifyCodexNativeSession(home, id, cwd, runID); err == nil {
		t.Fatal("later prompt nonce bypassed first-prompt ownership")
	}
	metaID = "00000000-0000-4000-8000-000000000001"
	write(meta(cwd) + "\n" + prompt("Fluke run "+runID) + "\n")
	if err := verifyCodexNativeSession(home, id, cwd, runID); err == nil {
		t.Fatal("filename UUID allowed different session metadata")
	}
	write(body)
	otherDate := filepath.Join(home, "sessions", "2026", "10", "07")
	if err := os.MkdirAll(otherDate, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(otherDate, filepath.Base(file)), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyCodexNativeSession(home, id, cwd, runID); err == nil {
		t.Fatal("ambiguous UUID transcripts were accepted")
	}
}

// No prompt is sent: even an unexpected fresh-session fallback cannot run an
// inference. The invalid UUID must never open a picker or choose another ID.
func TestLiveNativeMissingSessionWithoutInference(t *testing.T) {
	if os.Getenv("FLUKE_LIVE_RESUME_CHECK") != "1" {
		t.Skip("opt-in CLI startup only, no model prompt")
	}
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			id, err := newNativeSessionID()
			if err != nil {
				t.Fatal(err)
			}
			config := AgentConfig{Provider: provider, Executable: provider}
			if provider == "codex" {
				config.Arguments = []string{"--no-daemon", "--no-alt-screen", "--disable", "hooks", "-c", "check_for_update_on_startup=false"}
			} else {
				config.Arguments = []string{"--safe-mode", "--no-chrome"}
			}
			config, err = nativeResumeConfig(config, id)
			if err != nil {
				t.Fatal(err)
			}
			argv, err := launchArgv(config, "")
			if err != nil {
				t.Fatal(err)
			}
			manager := newWindowManager(160, 48)
			defer manager.Cleanup()
			manager.AddWindowIn(t.TempDir(), "Missing session check", argv...)
			if len(manager.Windows) != 1 {
				t.Fatal(manager.lastError)
			}
			window := manager.Windows[0]
			deadline := time.Now().Add(15 * time.Second)
			var screen string
			trusted := false
			for time.Now().Before(deadline) {
				screen = strings.ToLower(window.screen.String())
				if !trusted && (strings.Contains(screen, "yes, i trust this folder") || strings.Contains(screen, "yes, trust") || strings.Contains(screen, "trust this folder?") && strings.Contains(screen, "1. trust and continue")) {
					_ = window.sendPrompt("")
					trusted = true
				}
				if window.ProcessExited() {
					break
				}
				time.Sleep(40 * time.Millisecond)
			}
			if !(strings.Contains(screen, "no saved session") || strings.Contains(screen, "no conversation found") || strings.Contains(screen, "session not found")) {
				t.Fatalf("missing-session behavior not established (no prompt sent): %s", strings.Join(strings.Fields(screen), " "))
			}
			t.Logf("%s rejected a nonexistent exact UUID without inference", provider)
		})
	}
}
