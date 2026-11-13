package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAgent speaks ACP over in-memory pipes. handle runs once per request or
// notification the client sends and may write any lines back with send.
type fakeAgent struct {
	t      *testing.T
	client *acpClient
	out    io.WriteCloser // agent → client
	mu     sync.Mutex
	seen   []acpMessage
}

func newFakeAgent(t *testing.T, handle func(a *fakeAgent, msg acpMessage)) *fakeAgent {
	t.Helper()
	toAgentR, toAgentW := io.Pipe()
	toClientR, toClientW := io.Pipe()
	a := &fakeAgent{t: t, out: toClientW}
	a.client = newACPClient(toClientR, toAgentW)
	go func() {
		scanner := bufio.NewScanner(toAgentR)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for scanner.Scan() {
			var msg acpMessage
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				continue
			}
			a.mu.Lock()
			a.seen = append(a.seen, msg)
			a.mu.Unlock()
			handle(a, msg)
		}
	}()
	t.Cleanup(func() { toAgentW.Close(); toClientW.Close() })
	return a
}

func (a *fakeAgent) send(v any) {
	data, _ := json.Marshal(v)
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.out.Write(append(data, '\n'))
}

func (a *fakeAgent) raw(line string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = io.WriteString(a.out, line+"\n")
}

func (a *fakeAgent) result(id json.RawMessage, result any) {
	a.send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "result": result})
}

func (a *fakeAgent) update(session string, update map[string]any) {
	a.send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": session, "update": update}})
}

func (a *fakeAgent) methods() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, m := range a.seen {
		out = append(out, m.Method)
	}
	return out
}

func shortCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestACPHandshakeSessionAndStreamedTurn(t *testing.T) {
	var events []acpEvent
	var emu sync.Mutex
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		switch msg.Method {
		case "initialize":
			var p struct {
				ProtocolVersion    int `json:"protocolVersion"`
				ClientCapabilities struct {
					FS       struct{ ReadTextFile, WriteTextFile bool } `json:"fs"`
					Terminal bool                                       `json:"terminal"`
				} `json:"clientCapabilities"`
			}
			_ = json.Unmarshal(msg.Params, &p)
			if p.ProtocolVersion != 1 || p.ClientCapabilities.FS.ReadTextFile || p.ClientCapabilities.FS.WriteTextFile || p.ClientCapabilities.Terminal {
				t.Errorf("client advertised capabilities it does not implement: %s", msg.Params)
			}
			a.result(msg.ID, map[string]any{
				"protocolVersion":   1,
				"agentCapabilities": map[string]any{"loadSession": true, "promptCapabilities": map[string]any{"image": true}},
				"agentInfo":         map[string]any{"name": "fake", "version": "0.1"},
				"authMethods":       []any{map[string]any{"id": "login", "name": "Sign in"}},
			})
		case "session/new":
			a.result(msg.ID, map[string]any{"sessionId": "s1"})
		case "session/prompt":
			a.update("s1", map[string]any{"sessionUpdate": "plan", "entries": []any{map[string]any{"content": "Leer", "status": "in_progress", "priority": "high"}}})
			a.update("s1", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "Read go.mod", "kind": "read", "status": "pending"})
			a.update("s1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed", "content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "module x"}}}})
			a.update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Hola "}})
			a.update("s1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "mundo"}})
			a.update("s1", map[string]any{"sessionUpdate": "usage_update", "used": 1200, "size": 200000})
			a.result(msg.ID, map[string]any{"stopReason": "end_turn"})
		}
	})
	agent.client.OnEvent = func(e acpEvent) {
		emu.Lock()
		events = append(events, e)
		emu.Unlock()
	}
	ctx := shortCtx(t)
	info, err := agent.client.Initialize(ctx)
	if err != nil || info.Name != "fake" || !info.LoadSession || !info.Image || info.Audio || len(info.AuthMethods) != 1 || info.AuthMethods[0] != "Sign in" {
		t.Fatalf("%+v %v", info, err)
	}
	session, err := agent.client.NewSession(ctx, t.TempDir())
	if err != nil || session != "s1" {
		t.Fatalf("%q %v", session, err)
	}
	stop, err := agent.client.Prompt(ctx, session, "hola")
	if err != nil || stop != "end_turn" {
		t.Fatalf("%q %v", stop, err)
	}
	// Notifications are delivered in order, before the turn's response.
	emu.Lock()
	defer emu.Unlock()
	var kinds []string
	var text string
	for _, e := range events {
		kinds = append(kinds, e.Kind)
		if e.Kind == "message" {
			text += e.Text
		}
	}
	if strings.Join(kinds, ",") != "plan,tool,tool_update,message,message,usage" || text != "Hola mundo" {
		t.Fatalf("%v %q", kinds, text)
	}
	if events[1].Tool.Title != "Read go.mod" || events[2].Tool.Status != "completed" || events[2].Tool.Text[0] != "module x" {
		t.Fatalf("tool events %+v %+v", events[1].Tool, events[2].Tool)
	}
	if events[0].Plan[0].Content != "Leer" || events[5].Used != 1200 || events[5].Size != 200000 {
		t.Fatal("plan or usage lost")
	}
}

func TestACPPermissionRequestUsesPolicyAndRejectsByDefault(t *testing.T) {
	for _, tc := range []struct {
		name   string
		policy func(acpPermissionRequest) (string, bool)
		want   map[string]any
	}{
		{"policy allows", func(r acpPermissionRequest) (string, bool) { return r.Options[0].ID, true }, map[string]any{"outcome": "selected", "optionId": "yes"}},
		{"policy cancels", func(acpPermissionRequest) (string, bool) { return "", false }, map[string]any{"outcome": "cancelled"}},
		{"default rejects", nil, map[string]any{"outcome": "selected", "optionId": "no"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := make(chan map[string]any, 1)
			agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
				switch {
				case msg.Method == "session/prompt":
					a.send(map[string]any{"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": map[string]any{
						"sessionId": "s1",
						"toolCall":  map[string]any{"toolCallId": "c1", "title": "Run rm -rf build", "kind": "execute"},
						"options": []any{
							map[string]any{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
							map[string]any{"optionId": "no", "name": "Reject", "kind": "reject_once"},
						},
					}})
					a.mu.Lock()
					a.seen = append(a.seen, acpMessage{Method: "prompt-id", ID: msg.ID})
					a.mu.Unlock()
				case msg.Method == "" && string(msg.ID) == "900":
					var res struct {
						Outcome map[string]any `json:"outcome"`
					}
					_ = json.Unmarshal(msg.Result, &res)
					got <- res.Outcome
					a.mu.Lock()
					var promptID json.RawMessage
					for _, m := range a.seen {
						if m.Method == "prompt-id" {
							promptID = m.ID
						}
					}
					a.mu.Unlock()
					a.result(promptID, map[string]any{"stopReason": "end_turn"})
				}
			})
			agent.client.OnPermission = tc.policy
			if _, err := agent.client.Prompt(shortCtx(t), "s1", "x"); err != nil {
				t.Fatal(err)
			}
			outcome := <-got
			if outcome["outcome"] != tc.want["outcome"] || outcome["optionId"] != tc.want["optionId"] {
				t.Fatalf("%v", outcome)
			}
		})
	}
}

func TestACPDeclinesUnsupportedAgentRequests(t *testing.T) {
	got := make(chan acpMessage, 1)
	var newID json.RawMessage
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		switch {
		case msg.Method == "session/new":
			newID = msg.ID
			a.send(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "fs/read_text_file", "params": map[string]any{"path": "/etc/passwd"}})
		case msg.Method == "" && string(msg.ID) == "7":
			got <- msg
			a.result(newID, map[string]any{"sessionId": "s1"})
		}
	})
	if _, err := agent.client.NewSession(shortCtx(t), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if reply := <-got; reply.Error == nil || reply.Error.Code != -32601 {
		t.Fatalf("file access must be declined: %+v", reply)
	}
}

func TestACPErrorResponseAndNoise(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {
		a.raw("npm warn something that is not JSON")
		a.raw(`{"not":"rpc"}`)
		a.send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(msg.ID), "error": map[string]any{"code": -32000, "message": "Authentication required"}})
	})
	_, err := agent.client.Initialize(shortCtx(t))
	var rpcErr *acpError
	if !errors.As(err, &rpcErr) || rpcErr.Code != -32000 || !strings.Contains(err.Error(), "Authentication required") {
		t.Fatalf("%v", err)
	}
}

func TestACPAgentExitDoesNotHangACall(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) { _ = a.out.Close() })
	done := make(chan error, 1)
	go func() { _, err := agent.client.Prompt(context.Background(), "s1", "x"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a closed agent must be an error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("call hung after the agent closed its output")
	}
	if _, err := agent.client.NewSession(context.Background(), t.TempDir()); err == nil {
		t.Fatal("later calls must fail immediately")
	}
}

func TestACPCancellingAPromptAsksTheAgentToStop(t *testing.T) {
	agent := newFakeAgent(t, func(a *fakeAgent, msg acpMessage) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := agent.client.Prompt(ctx, "s1", "x"); done <- err }()
	deadline := time.Now().Add(2 * time.Second)
	for len(agent.methods()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("%v", err)
	}
	for !strings.Contains(strings.Join(agent.methods(), ","), "session/cancel") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := strings.Join(agent.methods(), ","); got != "session/prompt,session/cancel" {
		t.Fatalf("%s", got)
	}
}

func TestACPLaunchersOnlyReportExistingExecutables(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if argv, ok := acpAvailable("opencode"); ok {
		t.Fatalf("found %v in an empty PATH", argv)
	}
}
