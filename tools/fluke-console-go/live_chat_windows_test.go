package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/xpty"
	"github.com/hinshun/vt10x"
)

// This exercises follow-up delivery, not just the prompt passed at process start.
func TestLiveChatFollowups(t *testing.T) {
	provider := os.Getenv("FLUKE_LIVE_CHAT")
	if provider == "" {
		t.Skip("set FLUKE_LIVE_CHAT=claude or codex")
	}
	repo := testRepo(t)
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	a := AgentConfig{Provider: provider, Executable: "claude.exe", Arguments: []string{"--permission-mode", "acceptEdits", "--no-chrome", "--allowedTools", "Bash,PowerShell,Read,Write,Edit"}}
	if provider == "codex" {
		a.Executable = "codex.cmd"
		a.Arguments = []string{"--no-daemon", "--no-alt-screen", "--sandbox", "workspace-write", "--ask-for-approval", "never"}
	}
	if exe := os.Getenv("FLUKE_LIVE_CHAT_EXE"); exe != "" {
		a.Executable = exe
	}
	state.Orchestrator = &a
	state.Projects = []string{repo}
	m := newModel(store, state, repo)
	defer m.cleanup()
	m.width, m.height = 140, 40
	m.terminals.width, m.terminals.height = 140, 32
	m.chatDraft[repo] = "This is a chat transport test. Reply through update.json with exactly CHAT_READY. Do not create tasks or change project files."
	launch := m.start("")
	if launch == nil {
		t.Fatal(m.notice)
	}
	m.Update(launch())
	w := m.terminalFor("fluke:" + repo)
	if w == nil {
		t.Fatal(m.notice)
	}
	var run func(tea.Cmd)
	run = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		msg := cmd()
		if batch, ok := msg.(tea.BatchMsg); ok {
			for _, c := range batch {
				run(c)
			}
			return
		}
		// Timers are driven explicitly below; do not recursively schedule them.
		m.Update(msg)
	}
	trustAt := time.Time{}
	await := func(marker string, startup bool) {
		t.Helper()
		started := time.Now()
		nextLog := started
		for time.Since(started) < 100*time.Second {
			title, screen := w.agentSignals()
			// Only approve trust for this test's newly created repository at startup.
			if startup && strings.Contains(screen, "Yes, I trust this folder") && time.Since(trustAt) > time.Second {
				_ = w.sendPrompt("")
				trustAt = time.Now()
			}
			m.readOrchestratorMessages()
			run(m.dispatchChats())
			messages := m.state.Conversations[repo]
			if len(messages) > 0 && messages[len(messages)-1].Role == "fluke" && strings.Contains(messages[len(messages)-1].Text, marker) {
				t.Logf("%s received in %s", marker, time.Since(started).Round(time.Millisecond))
				return
			}
			if time.Now().After(nextLog) {
				t.Logf("await %s title=%q state=%s paste=%v\n%s", marker, title, detectAgentState(provider, title, screen), w.bracketedPaste.Load(), screen)
				nextLog = time.Now().Add(20 * time.Second)
			}
			time.Sleep(100 * time.Millisecond)
		}
		captureNativeScreen(t, w.screen, "go-chat-stalled")
		t.Fatalf("No %s without manual Enter.\n%s", marker, w.screen.String())
	}
	await("CHAT_READY", true)
	for _, marker := range []string{"CHAT_SECOND", "CHAT_THIRD", "CHAT_FOURTH"} {
		text := "Reply through update.json with exactly " + marker + ". This is a new human chat message. No other actions."
		if marker == "CHAT_THIRD" {
			text += "\nThis second line must arrive in the same message."
		}
		run(m.sendChat(text))
		await(marker, false)
	}
	captureNativeScreen(t, w.screen, "go-chat-followups")
}

func TestLiveNativeChat(t *testing.T) {
	binary, provider := os.Getenv("FLUKE_CONSOLE_TEST_BINARY"), os.Getenv("FLUKE_LIVE_CHAT")
	if binary == "" || provider == "" {
		t.Skip("requires FLUKE_CONSOLE_TEST_BINARY and FLUKE_LIVE_CHAT")
	}
	repo := testRepo(t)
	dir := t.TempDir()
	store, state, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state.Language = "en"
	state.Projects = []string{repo}
	a := AgentConfig{Provider: provider, Executable: "claude.exe", Arguments: []string{"--permission-mode", "acceptEdits", "--no-chrome", "--allowedTools", "Bash,PowerShell,Read,Write,Edit"}}
	if provider == "codex" {
		a.Executable = "codex.cmd"
		a.Arguments = []string{"--no-daemon", "--no-alt-screen", "--sandbox", "workspace-write", "--ask-for-approval", "never"}
	}
	if exe := os.Getenv("FLUKE_LIVE_CHAT_EXE"); exe != "" {
		a.Executable = exe
	}
	state.Orchestrator = &a
	if model := os.Getenv("FLUKE_LIVE_CHAT_MODEL"); model != "" {
		a.Model = model
	}
	if os.Getenv("FLUKE_LIVE_CHAT_DEFAULT_MODE") == "1" {
		a.Arguments = []string{"--no-chrome", "--allowedTools", "Bash,PowerShell,Read,Write,Edit"}
	}
	if mode := os.Getenv("FLUKE_LIVE_CHAT_MODE"); mode != "" {
		a.Arguments = append(a.Arguments, "--permission-mode", mode)
	}
	autonomous := os.Getenv("FLUKE_LIVE_AUTONOMOUS") == "1"
	if autonomous {
		a.Arguments = []string{"--no-chrome"}
		if provider == "codex" {
			a.Arguments = []string{"--no-daemon", "--no-alt-screen"}
		}
	}
	if err = store.save(state); err != nil {
		t.Fatal(err)
	}
	store.lock.Close()
	pty, err := xpty.NewPty(140, 40)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "--repo", repo, "--state-dir", dir)
	if autonomous {
		cmd.Args = append(cmd.Args, "--autonomous")
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if err = pty.Start(cmd); err != nil {
		pty.Close()
		t.Fatal(err)
	}
	defer func() { exec.Command("taskkill", "/PID", fmt.Sprint(cmd.Process.Pid), "/T", "/F").Run(); pty.Close() }()
	go cmd.Process.Wait()
	outer := vt10x.New(vt10x.WithSize(140, 40))
	go func() {
		buf := make([]byte, 32768)
		tail := ""
		for {
			n, e := pty.Read(buf)
			if n > 0 {
				outer.Write(buf[:n])
				q := tail + string(buf[:n])
				for range strings.Count(q, "\x1b[6n") {
					pty.Write([]byte("\x1b[1;1R"))
				}
				tail = q[max(0, len(q)-3):]
			}
			if e != nil {
				return
			}
		}
	}()
	input := func(s string) {
		t.Helper()
		if _, e := pty.Write([]byte(s)); e != nil {
			t.Fatal(e)
		}
	}
	connection := func() {
		outer.Lock()
		x, y := -1, -1
		for row := 0; row < 40; row++ {
			for col := 0; col < 128; col++ {
				match := true
				for n, r := range "[Connection]" {
					if outer.Cell(col+n, row).Char != r {
						match = false
						break
					}
				}
				if match {
					x, y = col+1, row+1
				}
			}
		}
		outer.Unlock()
		if x >= 0 {
			input(fmt.Sprintf("\x1b[<0;%d;%dM\x1b[<0;%d;%dm", x, y, x, y))
		} else {
			input("\x1bOR")
		}
	}
	wait := func(marker string) {
		t.Helper()
		until := time.Now().Add(20 * time.Second)
		for time.Now().Before(until) {
			if strings.Contains(outer.String(), marker) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("missing %s\n%s", marker, outer.String())
	}
	wait("[Workers]")
	prompt := "Chat transport test: for every human message, reply through update.json with exactly that message, preserving newlines and advancing seq. No tasks or project edits. For this initial message reply CHAT_READY."
	input("\x1b[200~" + prompt + "\x1b[201~")
	input("\r")
	await := func(marker string, startup bool) {
		t.Helper()
		started := time.Now()
		trust := false
		acknowledged := false
		for time.Since(started) < 110*time.Second {
			// Inspect durable replies rather than a marker echoed in the human transcript.
			data, e := os.ReadFile(filepath.Join(dir, "state.json"))
			var saved State
			if e == nil && json.Unmarshal(data, &saved) == nil {
				msgs := saved.Conversations[repo]
				if autonomous && !saved.AutonomousFluke {
					t.Fatal("autonomy was not persisted")
				}
				if !startup && !acknowledged {
					for i := len(msgs) - 1; i >= 0; i-- {
						if msgs[i].Role == "human" {
							if msgs[i].Text == marker && msgs[i].Delivery == "sent" {
								t.Logf("%q submission acknowledged in %s", marker, time.Since(started).Round(time.Millisecond))
								acknowledged = true
							}
							break
						}
					}
				}
				if len(msgs) > 0 && msgs[len(msgs)-1].Role == "fluke" && msgs[len(msgs)-1].Text == marker {
					t.Logf("%q reply in %s", marker, time.Since(started).Round(time.Millisecond))
					return
				}
			}
			if startup && !trust && strings.Contains(outer.String(), "NEEDS YOUR ATTENTION") {
				connection()
				time.Sleep(time.Second)
				if autonomous {
					t.Fatalf("autonomous startup required human input:\n%s", outer.String())
				}
				screen := outer.String()
				if strings.Contains(screen, "Yes, I trust this folder") || strings.Contains(screen, "Yes, trust") || strings.Contains(screen, "1. Trust and continue") {
					input("\r")
					input("\r")
					trust = true
				}
				input("\x1bOQ")
			}
			time.Sleep(100 * time.Millisecond)
		}
		captureNativeScreen(t, outer, "go-native-chat-stalled")
		connection()
		time.Sleep(time.Second)
		t.Fatalf("no reply to %q without native Enter\n%s", marker, outer.String())
	}
	await("CHAT_READY", true)
	input("\x1bOR")
	wait("No worker terminals open.")
	if strings.Contains(outer.String(), "FLUKE ·") {
		t.Fatal("internal console visible in worker workspace")
	}
	input("\x1bOQ")
	for _, marker := range []string{"hola", "test", "I want to build a new app", "line one\nline two", "/help", "fin"} {
		input("\x1b[200~" + marker + "\x1b[201~")
		input("\r")
		await(marker, false)
	}
	captureNativeScreen(t, outer, "go-native-chat-replies")
}
