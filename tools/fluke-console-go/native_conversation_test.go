package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hinshun/vt10x"
)

func nativeFinalFixture(provider, id, text string) map[string]any {
	if provider == "codex" {
		return map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "phase": "final_answer", "content": []any{map[string]any{"type": "output_text", "text": text}}}}
	}
	return map[string]any{"type": "assistant", "sessionId": id, "message": map[string]any{"role": "assistant", "stop_reason": "end_turn", "content": []any{map[string]any{"type": "text", "text": text}}}}
}

func TestNativeChatIntegrationAndIdleTimer(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			session, repo, path := nativeReaderFixture(t, provider)
			store, state, err := openStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.lock.Close()
			m := newModel(store, state, repo)
			w := &terminalWindow{ID: "chat", screen: vt10x.New(vt10x.WithSize(80, 20))}
			m.terminals.Windows = []*terminalWindow{w}
			m.sessions["fluke:"+repo] = w.ID
			defer func() { m.terminals.Windows = nil; m.sessions = map[string]string{}; m.cleanup() }()
			s := &orchestratorSession{RunID: "active", Dir: t.TempDir(), Provider: provider}
			m.orchestration[repo] = s
			if m.nativeChatPrompt(repo, "hola") != "hola" {
				t.Fatal("unverified session enabled native chat")
			}
			m.state = withOrchestratorSession(m.state, repo, &session)
			if !strings.HasPrefix(m.nativeChatPrompt(repo, "hola"), "[Fluke: respuesta nativa verificada]") {
				t.Fatal("verified session did not enable native chat")
			}
			if m.scheduleNativeReplyTick() != nil {
				t.Fatal("idle conversation uses a fast timer")
			}
			s.ReplyStarted = time.Now()
			s.nativeAwaiting = true
			if m.scheduleNativeReplyTick() == nil || m.scheduleNativeReplyTick() != nil || m.workerTickPending {
				t.Fatal("native reply timer is duplicated or starts worker polling")
			}
			appendNativeFixture(t, path, nativeFinalFixture(provider, session.ID, "¡Hola! ¿Cómo va?"))
			m.Update(nativeReplyTick{})
			if len(m.state.Conversations[repo]) != 1 || m.state.Conversations[repo][0].Text != "¡Hola! ¿Cómo va?" || m.nativeReplyTickPending {
				t.Fatal("native reply did not reach F2 or idle timer did not stop")
			}
			if s.Notify {
				t.Fatal("native reply woke itself")
			}
			// A progress report must not hide the final native reply. A second
			// human message can be queued, but must not reset the first cursor.
			m.nativeChatPrompt(repo, "work")
			s.nativeAwaiting, s.ReplyStarted = true, time.Now()
			if err := atomicJSON(filepath.Join(s.Dir, "update.json"), orchestratorMessage{Version: 1, RunID: s.RunID, Seq: 1, Message: "Progress"}); err != nil {
				t.Fatal(err)
			}
			m.pollOrchestrators()
			if !s.nativeAwaiting || !s.ReplyStarted.IsZero() {
				t.Fatal("progress ended the native reply wait")
			}
			s.PendingChat = &chatSentResult{Repo: repo, RunID: s.RunID, Seq: 2, Text: "next question"}
			s.ChatSending = true
			_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
			if m.dispatchChats() != nil {
				t.Fatal("queued chat discarded the previous reply cursor")
			}
			appendNativeFixture(t, path, nativeFinalFixture(provider, session.ID, "Final after progress"))
			m.readNativeReplies()
			messages := m.state.Conversations[repo]
			if len(messages) != 3 || messages[2].Text != "Final after progress" || s.nativeAwaiting || s.PendingChat == nil {
				t.Fatal("queued input or progress lost the final answer")
			}
			if m.dispatchChats() == nil {
				t.Fatal("next chat did not resume after the native final answer")
			}
		})
	}
}

func appendNativeFixture(t *testing.T, path string, event any) {
	t.Helper()
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = file.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
}

func nativeReaderFixture(t *testing.T, provider string) (NativeSession, string, string) {
	t.Helper()
	home, repo := t.TempDir(), t.TempDir()
	session := NativeSession{ID: "12345678-1234-4234-8234-123456789abc", InitialRun: strings.Repeat("a", 32), Config: AgentConfig{Provider: provider, Executable: provider}}
	var path string
	if provider == "codex" {
		t.Setenv("CODEX_HOME", home)
		path = filepath.Join(home, "sessions", "2026", "10", "09", "rollout-test-"+session.ID+".jsonl")
	} else {
		t.Setenv("CLAUDE_CONFIG_DIR", home)
		path = filepath.Join(home, "projects", "test", session.ID+".jsonl")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if provider == "codex" {
		appendNativeFixture(t, path, map[string]any{"type": "session_meta", "payload": map[string]any{"id": session.ID, "cwd": repo}})
		appendNativeFixture(t, path, map[string]any{"type": "event_msg", "payload": map[string]any{"type": "user_message", "message": "Run activo de Fluke: " + session.InitialRun}})
	} else {
		appendNativeFixture(t, path, map[string]any{"type": "user", "sessionId": session.ID, "cwd": repo, "message": map[string]any{"role": "user", "content": "Run activo de Fluke: " + session.InitialRun}})
	}
	appendNativeFixture(t, path, nativeFinalFixture(provider, session.ID, "Historical reply"))
	return session, repo, path
}

func TestNativeReplyChannelVerifiesIdentityAndSkipsHistory(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			session, repo, path := nativeReaderFixture(t, provider)
			for _, wrong := range []string{"repo", "run", "uuid"} {
				bad, dir := session, repo
				switch wrong {
				case "repo":
					dir = t.TempDir()
				case "run":
					bad.InitialRun = strings.Repeat("b", 32)
				case "uuid":
					bad.ID = "87654321-1234-4234-8234-123456789abc"
				}
				if _, err := openNativeReplyReader(bad, dir); err == nil {
					t.Fatal("accepted wrong", wrong)
				}
			}
			r, err := openNativeReplyReader(session, repo)
			if err != nil {
				t.Fatal(err)
			}
			if replies, err := r.replies(); err != nil || len(replies) != 0 {
				t.Fatal("replayed history", replies, err)
			}
			appendNativeFixture(t, path, nativeFinalFixture(provider, session.ID, "Before this chat"))
			if err := r.beginReply(); err != nil {
				t.Fatal(err)
			}
			appendNativeFixture(t, path, nativeFinalFixture(provider, session.ID, "Fresh reply"))
			replies, err := r.replies()
			if err != nil || len(replies) != 1 || replies[0] != "Fresh reply" {
				t.Fatal(replies, err)
			}
			if replies, err := r.replies(); err != nil || len(replies) != 0 {
				t.Fatal("duplicate reply", replies, err)
			}
			if err := os.WriteFile(path, nil, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := r.replies(); err == nil {
				t.Fatal("accepted truncated history")
			}
		})
	}
}

func TestNativeConversationOnlyDisplaysFinalAssistantText(t *testing.T) {
	id := "12345678-1234-4234-8234-123456789abc"
	for _, provider := range []string{"codex", "claude"} {
		good := nativeFinalFixture(provider, id, "Visible")
		data, _ := json.Marshal(good)
		if nativeFinalReply(provider, id, data) != "Visible" {
			t.Fatal("missing final", provider)
		}
		for _, change := range []string{"user", "thinking", "tool", "commentary", "wrong-session"} {
			bad := nativeFinalFixture(provider, id, "PRIVATE")
			if provider == "codex" {
				p := bad["payload"].(map[string]any)
				switch change {
				case "user":
					p["role"] = "user"
				case "thinking":
					p["type"] = "reasoning"
				case "tool":
					p["content"] = []any{map[string]any{"type": "function_call", "text": "PRIVATE"}}
				default:
					p["phase"] = "commentary"
				}
			} else {
				p := bad["message"].(map[string]any)
				switch change {
				case "user":
					p["role"] = "user"
				case "thinking":
					p["content"] = []any{map[string]any{"type": "thinking", "text": "PRIVATE"}}
				case "tool":
					p["stop_reason"] = "tool_use"
				case "commentary":
					p["stop_reason"] = nil
				case "wrong-session":
					bad["sessionId"] = "other"
				}
			}
			data, _ := json.Marshal(bad)
			if nativeFinalReply(provider, id, data) != "" {
				t.Fatal("leaked non-final content", provider, change)
			}
		}
	}
	mixed := nativeFinalFixture("claude", id, "Visible")
	mixed["message"].(map[string]any)["content"] = []any{map[string]any{"type": "thinking", "thinking": "PRIVATE"}, map[string]any{"type": "text", "text": "Visible"}}
	data, _ := json.Marshal(mixed)
	if nativeFinalReply("claude", id, data) != "Visible" {
		t.Fatal("mixed final reply leaked thinking or lost visible text")
	}
}

func TestNativeReplyWaitsForCompleteLineAndRetriesFailedSave(t *testing.T) {
	session, repo, path := nativeReaderFixture(t, "codex")
	r, err := openNativeReplyReader(session, repo)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(nativeFinalFixture("codex", session.ID, "Do not lose this reply"))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write(data[:len(data)/2]); err != nil {
		t.Fatal(err)
	}
	if replies, err := r.replies(); err != nil || len(replies) != 0 {
		t.Fatal("accepted partial line", replies, err)
	}
	if _, err = file.Write(append(data[len(data)/2:], '\n')); err != nil {
		t.Fatal(err)
	}
	file.Close()
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	m := newModel(store, state, repo)
	defer m.cleanup()
	s := &orchestratorSession{RunID: "active", nativeReplies: r, nativeAwaiting: true, ReplyStarted: time.Now()}
	m.orchestration[repo] = s
	stateFile := filepath.Join(store.dir, "state.json")
	if err := os.Mkdir(stateFile, 0700); err != nil {
		t.Fatal(err)
	}
	m.readNativeReplies()
	if len(r.pendingReplies) != 1 || len(m.state.Conversations[repo]) != 0 || s.ReplyStarted.IsZero() {
		t.Fatal("failed save lost reply")
	}
	if err := os.Remove(stateFile); err != nil {
		t.Fatal(err)
	}
	m.readNativeReplies()
	m.readNativeReplies()
	if len(m.state.Conversations[repo]) != 1 || m.state.Conversations[repo][0].Text != "Do not lose this reply" || !s.ReplyStarted.IsZero() {
		t.Fatal("reply not saved exactly once")
	}
}
