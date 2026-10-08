package main

import (
	tea "charm.land/bubbletea/v2"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type orchestratorMessage struct {
	Version         int    `json:"version"`
	RunID           string `json:"run_id"`
	Seq             uint64 `json:"seq"`
	Message         string `json:"message"`
	NativeSessionID string `json:"native_session_id,omitempty"`
}
type chatSentResult struct {
	Repo, RunID, Text string
	Seq               uint64
	Err               error
}

func withConversation(state State, repo string, msg ConversationMessage) State {
	next := state
	next.Conversations = map[string][]ConversationMessage{}
	for key, messages := range state.Conversations {
		next.Conversations[key] = messages
	}
	messages := append(append([]ConversationMessage{}, state.Conversations[repo]...), msg)
	if len(messages) > 100 {
		messages = messages[len(messages)-100:]
	}
	next.Conversations[repo] = messages
	return next
}
func (m *model) readOrchestratorMessages() {
	for repo, s := range m.orchestration {
		f, err := os.Open(filepath.Join(s.Dir, "update.json"))
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
			_ = f.Close()
			continue
		}
		var msg orchestratorMessage
		err = json.NewDecoder(io.LimitReader(f, 16385)).Decode(&msg)
		_ = f.Close()
		text := conciseAgentMessage(msg.Message)
		if err != nil || msg.Version != 1 || msg.RunID != s.RunID || msg.Seq <= s.ReportSeq || text == "" {
			continue
		}
		duplicate := false
		messages := m.state.Conversations[repo]
		if len(messages) > 0 {
			last := messages[len(messages)-1]
			duplicate = last.Role == "fluke" && last.RunID == s.RunID && last.Text == text
		}
		if duplicate {
			s.ReportSeq = msg.Seq
			continue
		}
		next := withConversation(m.state, repo, ConversationMessage{Role: "fluke", Text: text, RunID: s.RunID, Seq: msg.Seq})
		var previous *NativeSession
		if saved, ok := next.OrchestratorSessions[repo]; ok {
			previous = &saved
		}
		next = withOrchestratorSession(next, repo, capturedCodexSession(s.Config, msg.NativeSessionID, repo, s.RunID, previous))
		if err = m.store.save(next); err != nil {
			m.notice = uiText("No se pudo guardar el mensaje de Fluke: ") + err.Error()
			continue
		}
		m.state = next
		s.ReportSeq = msg.Seq
	}
}

// Keep the promised concise channel bounded even if a provider ignores its
// prompt. Native output and the original report remain available separately.
func conciseAgentMessage(text string) string {
	text = strings.TrimSpace(reviewText(text))
	lines := strings.Split(text, "\n")
	cut := false
	if len(lines) > 6 {
		text = strings.Join(lines[:6], "\n")
		cut = true
	}
	runes := []rune(text)
	if len(runes) > 1200 {
		text = string(runes[:1200])
		cut = true
	}
	if cut {
		text = strings.TrimSpace(text) + uiText("\n… F3 tiene la sesión completa.")
	}
	return text
}
func (m *model) sendChat(text string) tea.Cmd {
	repo := m.repo
	s := m.orchestration[repo]
	w := m.terminalFor("fluke:" + repo)
	if s == nil || w == nil || w.ProcessExited() {
		m.notice = uiText("Abrí el orquestador para conversar.")
		return nil
	}
	if s.ChatSending {
		m.notice = uiText("Esperá a que se entregue el mensaje actual.")
		return nil
	}
	if len(text) > 16000 {
		m.notice = uiText("El mensaje es demasiado largo; resumí el pedido o referenciá un archivo del repo.")
		return nil
	}
	s.ChatSeq++
	seq := s.ChatSeq
	runID := s.RunID
	next := withConversation(m.state, repo, ConversationMessage{Role: "human", Text: text, RunID: runID, Seq: seq, Delivery: "pending"})
	if err := m.store.save(next); err != nil {
		m.notice = uiText("No se pudo guardar tu mensaje: ") + err.Error()
		return nil
	}
	m.state = next
	s.ChatSending = true
	s.PendingChat = &chatSentResult{Repo: repo, RunID: runID, Seq: seq, Text: text}
	// Once durably queued, the transcript owns the message. Free the composer
	// immediately so a slow CLI doesn't concatenate the next draft onto it.
	if m.chatDraft[repo] == text {
		m.chatDraft[repo] = ""
	}
	w.conversationPending.Store(m.chatDraft[repo] != "")
	return tea.Batch(m.dispatchChats(), m.scheduleWorkerTick())
}
func (m *model) receiveChatSent(v chatSentResult) {
	s := m.orchestration[v.Repo]
	if s != nil && s.RunID == v.RunID {
		s.ChatWriting = false
		if errors.Is(v.Err, errAutomaticDeferred) {
			return
		}
		s.ChatSending = false
		s.PendingChat = nil
	}
	next := m.state
	next.Conversations = map[string][]ConversationMessage{}
	for repo, messages := range m.state.Conversations {
		next.Conversations[repo] = messages
	}
	next.Conversations[v.Repo] = append([]ConversationMessage{}, m.state.Conversations[v.Repo]...)
	for i, msg := range next.Conversations[v.Repo] {
		if msg.Role == "human" && msg.RunID == v.RunID && msg.Seq == v.Seq {
			next.Conversations[v.Repo][i].Delivery = "sent"
			if v.Err != nil {
				next.Conversations[v.Repo][i].Delivery = "uncertain"
			}
			break
		}
	}
	if err := m.store.save(next); err != nil {
		m.notice = uiText("Revisá la sesión: el envío no pudo confirmarse en el estado.")
		return
	}
	m.state = next
	if v.Err != nil {
		m.notice = uiText("Envío incierto. Revisá la sesión antes de reenviar.")
		return
	}
	if w := m.terminalFor("fluke:" + v.Repo); w != nil {
		w.conversationPending.Store(m.chatDraft[v.Repo] != "")
	}
	m.refreshOrchestrators(false)
	m.notice = "Mensaje enviado a Fluke."
}
func conversationTranscript(messages []ConversationMessage, w, h int) string {
	return conversationTranscriptAt(messages, w, h, 0)
}
func conversationTranscriptAt(messages []ConversationMessage, w, h, offset int) string {
	lines := brandTranscriptLines(messages, w)
	end := max(min(len(lines), h), len(lines)-max(0, offset))
	return strings.Join(lines[max(0, end-max(1, h)):end], "\n")
}

func (m *model) dispatchChats() tea.Cmd {
	var commands []tea.Cmd
	for repo, s := range m.orchestration {
		if s.PendingChat == nil || s.ChatWriting {
			continue
		}
		w := m.terminalFor("fluke:" + repo)
		if w == nil || w.ProcessExited() {
			continue
		}
		title, screen := w.agentSignals()
		if w.userInputPending.Load() || detectAgentState(s.Provider, title, screen) != "idle" {
			continue
		}
		msg := *s.PendingChat
		provider := s.Provider
		s.ChatWriting = true
		commands = append(commands, func() tea.Msg { msg.Err = w.sendQueuedChat(provider, msg.Text); return msg })
	}
	return tea.Batch(commands...)
}
