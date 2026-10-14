package main

import (
	"bytes"
	"path/filepath"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

var titleSequence = regexp.MustCompile("\x1b\\]0;([^\x07]*)\x07")

func titles(out string) []string {
	var states []string
	for _, m := range titleSequence.FindAllStringSubmatch(out, -1) {
		states = append(states, acpTitleState(m[1]))
	}
	return states
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func lastTitle(out *lockedBuffer) string {
	s := titles(out.String())
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
}

func TestACPTitleStateMatchesWhatFlukeReads(t *testing.T) {
	for title, want := range map[string]string{
		"fluke-acp:working": "working", "fluke-acp:blocked": "blocked", "fluke-acp:idle": "idle",
		"fluke-acp:starting": "unknown", "powershell.exe": "unknown", "": "unknown",
	} {
		if got := detectAgentState("opencode", title, ""); got != want {
			t.Errorf("%q: %s, want %s", title, got, want)
		}
	}
	if detectAgentState("custom", "fluke-acp:idle", "") != "unknown" {
		t.Error("only the opencode provider is read from the ACP title")
	}
}

func TestBridgeRunsTurnAndReportsStateThroughTitle(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		if msg.Method != "session/prompt" {
			return
		}
		a.update("s1", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Read .fluke-task.md", "kind": "read", "status": "pending"})
		a.update("s1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})
		a.update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Listo.\nVerifiqué."}})
		a.result(msg.ID, map[string]any{"stopReason": "end_turn"})
	})
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session = "s1"
	bridge.setState("idle")
	bridge.startTurn("Leé el contrato")
	waitFor(t, "turn to finish", func() bool { return strings.Contains(out.String(), "turn finished") })
	text := out.String()
	for _, want := range []string{"▸ Read .fluke-task.md", "✓ completed", "Listo.\r\nVerifiqué.", "(end_turn)"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %q", want, text)
		}
	}
	waitFor(t, "idle title", func() bool { return lastTitle(out) == "idle" && len(titles(out.String())) >= 3 })
	if got := strings.Join(titles(out.String()), ","); got != "idle,working,idle" {
		t.Fatalf("states %s", got)
	}
}

func TestBridgePermissionWaitsForTheHumanAndNeverApprovesAlone(t *testing.T) {
	got := make(chan string, 1)
	var promptID json.RawMessage
	var mu sync.Mutex
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		switch {
		case msg.Method == "session/prompt":
			mu.Lock()
			promptID = msg.ID
			mu.Unlock()
			a.send(map[string]any{"jsonrpc": "2.0", "id": 500, "method": "session/request_permission", "params": map[string]any{
				"sessionId": "s1",
				"toolCall":  map[string]any{"toolCallId": "c1", "title": "Run npm install"},
				"options": []any{
					map[string]any{"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
					map[string]any{"optionId": "deny", "name": "Reject", "kind": "reject_once"},
				},
			}})
		case msg.Method == "" && string(msg.ID) == "500":
			var res struct {
				Outcome map[string]any `json:"outcome"`
			}
			_ = json.Unmarshal(msg.Result, &res)
			id, _ := res.Outcome["optionId"].(string)
			got <- id
			mu.Lock()
			defer mu.Unlock()
			a.result(promptID, map[string]any{"stopReason": "end_turn"})
		}
	})
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session = "s1"
	input, writer := io.Pipe()
	go bridge.readInput(input)
	defer writer.Close()

	bridge.startTurn("instalá dependencias")
	waitFor(t, "permission prompt", func() bool { return strings.Contains(out.String(), "Permission requested: Run npm install") })
	waitFor(t, "blocked title", func() bool { return lastTitle(out) == "blocked" })
	select {
	case id := <-got:
		t.Fatalf("answered without the human: %q", id)
	case <-time.After(150 * time.Millisecond):
	}
	_, _ = writer.Write([]byte("1\r"))
	select {
	case id := <-got:
		if id != "allow" {
			t.Fatalf("selected %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the answer never reached the agent")
	}
	waitFor(t, "turn to finish", func() bool { return strings.Contains(out.String(), "turn finished") })
}

func TestBridgeBlankAnswerRejectsAPermission(t *testing.T) {
	got := make(chan string, 1)
	var promptID json.RawMessage
	var mu sync.Mutex
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		switch {
		case msg.Method == "session/prompt":
			mu.Lock()
			promptID = msg.ID
			mu.Unlock()
			a.send(map[string]any{"jsonrpc": "2.0", "id": 600, "method": "session/request_permission", "params": map[string]any{
				"sessionId": "s1",
				"toolCall":  map[string]any{"toolCallId": "c1", "title": "Delete files"},
				"options": []any{
					map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
					map[string]any{"optionId": "deny", "name": "Reject", "kind": "reject_once"},
				},
			}})
		case msg.Method == "" && string(msg.ID) == "600":
			var res struct {
				Outcome map[string]any `json:"outcome"`
			}
			_ = json.Unmarshal(msg.Result, &res)
			id, _ := res.Outcome["optionId"].(string)
			got <- id
			mu.Lock()
			defer mu.Unlock()
			a.result(promptID, map[string]any{"stopReason": "end_turn"})
		}
	})
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session = "s1"
	input, writer := io.Pipe()
	go bridge.readInput(input)
	defer writer.Close()
	bridge.startTurn("borrá todo")
	waitFor(t, "blocked", func() bool { return lastTitle(out) == "blocked" })
	_, _ = writer.Write([]byte("\r"))
	select {
	case id := <-got:
		if id != "deny" {
			t.Fatalf("a blank answer must reject, got %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no answer reached the agent")
	}
}

func TestBridgePasteStaysOnePrompt(t *testing.T) {
	prompts := make(chan string, 2)
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		if msg.Method != "session/prompt" {
			return
		}
		var p struct {
			Prompt []struct {
				Text string `json:"text"`
			} `json:"prompt"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		prompts <- p.Prompt[0].Text
		a.result(msg.ID, map[string]any{"stopReason": "end_turn"})
	})
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session = "s1"
	input, writer := io.Pipe()
	go bridge.readInput(input)
	defer writer.Close()
	_, _ = writer.Write([]byte("\x1b[200~primera línea\r\nsegunda línea\x1b[201~\r"))
	select {
	case text := <-prompts:
		if text != "primera línea\nsegunda línea" {
			t.Fatalf("%q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pasted text never became a prompt")
	}
}

func TestBridgeCtrlCCancelsTheRunningTurn(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		if msg.Method == "session/cancel" {
			a.mu.Lock()
			var id json.RawMessage
			for _, m := range a.seen {
				if m.Method == "session/prompt" {
					id = m.ID
				}
			}
			a.mu.Unlock()
			a.result(id, map[string]any{"stopReason": "cancelled"})
		}
	})
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session = "s1"
	input, writer := io.Pipe()
	go bridge.readInput(input)
	defer writer.Close()
	bridge.startTurn("algo largo")
	waitFor(t, "prompt to reach the agent", func() bool { return strings.Contains(strings.Join(agent.methods(), ","), "session/prompt") })
	waitFor(t, "working", func() bool { return lastTitle(out) == "working" })
	_, _ = writer.Write([]byte{0x03})
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(out.String(), "turn cancelled") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(out.String(), "turn cancelled") {
		t.Fatalf("not cancelled; output %q; agent saw %v", out.String(), agent.methods())
	}
}

func TestACPWorkerArgvRunsThisBinaryAndRefusesAModel(t *testing.T) {
	a := AgentConfig{Provider: "opencode", Executable: "opencode"}
	argv, err := launchArgv(a, "Leé el contrato")
	if err != nil {
		t.Fatal(err)
	}
	if len(argv) != 5 || argv[1] != "--acp-worker" || argv[2] != "opencode" || argv[3] != "--" || argv[4] != "Leé el contrato" {
		t.Fatalf("%v", argv)
	}
	a.Model = "deepseek/deepseek-chat"
	if _, err := launchArgv(a, "x"); err == nil {
		t.Fatal("a per-task model must be refused for an ACP agent")
	}
	if err := validateNativeSessionConfig(AgentConfig{Provider: "opencode", Executable: "opencode"}); err != nil {
		t.Fatal(err)
	}
}

func TestSignalChannelWritesAreGrantedAndNothingElseIs(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "worktree")
	b := &acpBridge{out: &lockedBuffer{}, cwd: cwd}
	options := []acpPermissionOption{{"yes", "Allow once", "allow_once"}, {"no", "Reject", "reject_once"}}
	report := filepath.Join(cwd, ".fluke-worker", "t1-run-state.json")
	for name, tc := range map[string]struct {
		tool acpToolCall
		want bool
	}{
		"report file by title":     {acpToolCall{Kind: "edit", Title: report}, true},
		"report file by location":  {acpToolCall{Kind: "edit", Title: "write", Paths: []string{report}}, true},
		"temp file in the channel": {acpToolCall{Kind: "edit", Title: report + ".tmp"}, true},
		"a source file":            {acpToolCall{Kind: "edit", Title: filepath.Join(cwd, "main.go")}, false},
		"the channel's parent":     {acpToolCall{Kind: "edit", Title: filepath.Join(cwd, ".fluke-worker")}, false},
		"traversal out of it":      {acpToolCall{Kind: "edit", Title: filepath.Join(cwd, ".fluke-worker", "..", "secret.txt")}, false},
		"inside plus outside":      {acpToolCall{Kind: "edit", Paths: []string{report, filepath.Join(cwd, "x.go")}}, false},
		"a shell command":          {acpToolCall{Kind: "execute", Title: "Move-Item " + report}, false},
		"relative path":            {acpToolCall{Kind: "edit", Title: ".fluke-worker/state.json"}, false},
	} {
		id, ok := b.signalChannelOption(acpPermissionRequest{Tool: tc.tool, Options: options})
		if ok != tc.want || (ok && id != "yes") {
			t.Errorf("%s: granted=%v id=%q, want %v", name, ok, id, tc.want)
		}
	}
	if _, ok := b.signalChannelOption(acpPermissionRequest{Tool: acpToolCall{Kind: "edit", Title: report}, Options: []acpPermissionOption{{"no", "Reject", "reject_once"}}}); ok {
		t.Error("without an allow_once option nothing can be granted")
	}
}

func TestBridgeSaysWhenTheAgentGoesQuiet(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {}) // never answers the prompt
	out := &lockedBuffer{}
	bridge := newACPBridge(agent.client, out, t.TempDir())
	bridge.session, bridge.heartbeat = "s1", 60*time.Millisecond
	bridge.startTurn("algo")
	waitFor(t, "a silence notice", func() bool { return strings.Contains(out.String(), "no news from the agent") })
	bridge.client.Cancel("s1")
}
