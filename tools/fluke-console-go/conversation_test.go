package main

import (
	"github.com/hinshun/vt10x"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSummaryStaysBoundedAndUnicodeSafe(t *testing.T) {
	text := conciseAgentMessage("Entrega lista\n" + strings.Repeat("á", 1500))
	if len([]rune(text)) > 1240 || !strings.HasPrefix(text, "Entrega lista") || !strings.Contains(text, "F3") {
		t.Fatal("un reporte largo desbordó el canal de resúmenes")
	}
	text = conciseAgentMessage("uno\ndos\ntres\ncuatro\ncinco\nseis\nruido extra")
	if strings.Contains(text, "ruido extra") || !strings.Contains(text, "seis") {
		t.Fatal("el resumen no respeta su límite de líneas")
	}
}

func TestQueuedChatFreesComposerWithoutErasingNextDraft(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	m := newModel(store, state, repo)
	w := &terminalWindow{ID: "chat", screen: vt10x.New(vt10x.WithSize(80, 20))}
	_, _ = w.screen.Write([]byte("\x1b]0;Action Required\x07"))
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions["fluke:"+repo] = w.ID
	m.orchestration[repo] = &orchestratorSession{RunID: "run", Provider: "codex", Dir: t.TempDir()}
	defer func() { m.terminals.Windows = nil; m.sessions = map[string]string{}; m.cleanup() }()
	m.chatDraft[repo] = "Continuá"
	m.sendChat("Continuá")
	if m.chatDraft[repo] != "" || len(m.state.Conversations[repo]) != 1 || m.state.Conversations[repo][0].Delivery != "pending" {
		t.Fatal("una CLI bloqueada retiene el mensaje en el compositor")
	}
	// A second intentionally identical draft must survive the first send's ack.
	m.chatDraft[repo] = "Continuá"
	m.receiveChatSent(*m.orchestration[repo].PendingChat)
	if m.chatDraft[repo] != "Continuá" || m.state.Conversations[repo][0].Delivery != "sent" {
		t.Fatal("confirmar el envío borró un borrador humano nuevo")
	}
}

func TestConversationReportsAndQueuedInput(t *testing.T) {
	store, state, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.lock.Close()
	repo := t.TempDir()
	m := newModel(store, state, repo)
	dir := t.TempDir()
	s := &orchestratorSession{RunID: "run", Dir: dir, Provider: "codex"}
	m.orchestration[repo] = s
	w := &terminalWindow{ID: "chat", writer: &ptyWriter{}, screen: vt10x.New(vt10x.WithSize(80, 20))}
	m.terminals.Windows = []*terminalWindow{w}
	m.sessions["fluke:"+repo] = w.ID
	defer func() { m.terminals.Windows = nil; m.sessions = map[string]string{}; m.cleanup() }()
	report := orchestratorMessage{Version: 1, RunID: "stale", Seq: 1, Message: "Wrong session"}
	_ = atomicJSON(filepath.Join(dir, "update.json"), report)
	m.readOrchestratorMessages()
	if len(m.state.Conversations[repo]) != 0 {
		t.Fatal("stale conversation accepted")
	}
	report.RunID = "run"
	report.Message = "Listo para revisión.\x1b[31m"
	_ = atomicJSON(filepath.Join(dir, "update.json"), report)
	m.readOrchestratorMessages()
	m.readOrchestratorMessages()
	if len(m.state.Conversations[repo]) != 1 || s.Notify {
		t.Fatal("duplicate report / reply wakes itself")
	}
	report.Seq = 2
	_ = atomicJSON(filepath.Join(dir, "update.json"), report)
	m.readOrchestratorMessages()
	if len(m.state.Conversations[repo]) != 1 {
		t.Fatal("repeated identical status adds noise")
	}
	_, _ = w.screen.Write([]byte("\x1b]0;Action Required\x07"))
	m.chatDraft[repo] = "Continuá dentro del alcance"
	m.markConversationDraft()
	_ = m.sendChat(m.chatDraft[repo])
	if s.PendingChat == nil || s.ChatWriting || !s.ChatSending {
		t.Fatal("human message not queued at native permission dialog")
	}
	_, _ = w.screen.Write([]byte("\x1b]0;Codex\x07"))
	w.userInputPending.Store(true)
	if m.dispatchChats() != nil {
		t.Fatal("queued chat interrupts native draft")
	}
	w.userInputPending.Store(false)
	cmd := m.dispatchChats()
	if cmd == nil {
		t.Fatal("queued chat not dispatchable when ready")
	}
	w.userInputPending.Store(true)
	m.Update(cmd())
	if s.PendingChat == nil || s.ChatWriting || m.state.Conversations[repo][1].Delivery != "pending" {
		t.Fatal("race drops pending human chat")
	}
	text := conversationTranscript(m.state.Conversations[repo], 50, 20)
	if !strings.Contains(text, "FLUKE") || !strings.Contains(text, "VOS") || strings.Contains(text, "[31m") {
		t.Fatal("conversation not distinct or contains terminal noise")
	}
	if err = store.save(m.state); err != nil {
		t.Fatal(err)
	}
	_ = store.lock.Close()
	reopened, recovered, err := openStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.lock.Close()
	if recovered.Conversations[repo][1].Delivery != "uncertain" {
		t.Fatal("restart blindly retries pending chat")
	}
	if err = os.WriteFile(filepath.Join(dir, "update.json"), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	m.readOrchestratorMessages()
	if len(m.state.Conversations[repo]) != 2 {
		t.Fatal("malformed message changed transcript")
	}
}
