package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Native transcript formats are internal. Only enable this channel after
// checking the exact UUID, repository and original Fluke run; unknown formats
// keep the update.json channel. Never copy tools or reasoning into F2.
type nativeReplyReader struct {
	home, relative, provider, sessionID string
	identity                            os.FileInfo
	offset                              int64
	partial                             []byte
	discard                             bool
	pendingReplies                      []string
}

func openNativeReplyReader(session NativeSession, repo string) (*nativeReplyReader, error) {
	if !validStoredNativeSession(session) {
		return nil, errors.New("invalid native session")
	}
	var home, pattern string
	var err error
	if session.Config.Provider == "codex" {
		home, err = codexSessionHome()
		if err == nil {
			err = verifyCodexNativeSession(home, session.ID, repo, session.InitialRun)
		}
		pattern = filepath.Join(home, "sessions", "[0-9][0-9][0-9][0-9]", "[0-9][0-9]", "[0-9][0-9]", "rollout-*-"+strings.ToLower(session.ID)+".jsonl")
	} else {
		home, err = os.UserHomeDir()
		home = filepath.Join(home, ".claude")
		if configured := os.Getenv("CLAUDE_CONFIG_DIR"); configured != "" {
			home, err = filepath.Abs(configured)
		}
		pattern = filepath.Join(home, "projects", "*", strings.ToLower(session.ID)+".jsonl")
	}
	if err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) != 1 {
		return nil, errors.New("native transcript is not unique")
	}
	relative, err := filepath.Rel(home, matches[0])
	if err != nil || !filepath.IsLocal(relative) {
		return nil, errors.New("invalid native transcript path")
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(relative)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("native transcript is not a regular file")
	}
	if session.Config.Provider == "claude" {
		file, err := root.Open(relative)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		scanner := bufio.NewScanner(io.LimitReader(file, 2*1024*1024))
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		verified := false
		for scanner.Scan() {
			var event struct {
				Type, SessionID, Cwd string
				Message              struct {
					Role    string
					Content json.RawMessage
				}
			}
			if json.Unmarshal(scanner.Bytes(), &event) != nil {
				break
			}
			if event.Type != "user" || event.Message.Role != "user" {
				continue
			}
			var prompt string
			if json.Unmarshal(event.Message.Content, &prompt) != nil {
				var parts []struct{ Type, Text string }
				if json.Unmarshal(event.Message.Content, &parts) != nil {
					break
				}
				for _, part := range parts {
					if part.Type == "text" {
						prompt += part.Text
					}
				}
			}
			verified = strings.EqualFold(event.SessionID, session.ID) && dependencySamePath(event.Cwd, repo) && strings.Contains(prompt, session.InitialRun)
			break
		}
		if !verified {
			return nil, errors.New("Claude transcript does not belong to this Fluke run")
		}
	}
	reader := &nativeReplyReader{home: home, relative: relative, provider: session.Config.Provider, sessionID: session.ID, identity: info, offset: max(0, info.Size()-512*1024)}
	known, err := reader.replies()
	if err != nil || len(known) == 0 {
		return nil, errors.New("native final-answer format is not verified")
	}
	reader.offset, reader.partial, reader.discard = info.Size(), nil, false
	return reader, nil
}

func (r *nativeReplyReader) open() (*os.File, error) {
	root, err := os.OpenRoot(r.home)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(r.relative)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(r.identity, info) || info.Size() < r.offset {
		return nil, errors.New("native transcript changed identity or was truncated")
	}
	return root.Open(r.relative)
}

func (r *nativeReplyReader) beginReply() error {
	file, err := r.open()
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	r.offset, r.partial, r.discard = info.Size(), nil, false
	return nil
}

func (r *nativeReplyReader) replies() ([]string, error) {
	file, err := r.open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err = file.Seek(r.offset, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(io.LimitReader(file, 512*1024), 32*1024)
	var replies []string
	for {
		part, err := reader.ReadSlice('\n')
		r.offset += int64(len(part))
		if len(r.partial)+len(part) > 1024*1024 {
			r.partial = nil
			r.discard = true
		}
		if !r.discard {
			r.partial = append(r.partial, part...)
		}
		if len(part) > 0 && part[len(part)-1] == '\n' {
			if !r.discard {
				if text := nativeFinalReply(r.provider, r.sessionID, r.partial); text != "" {
					replies = append(replies, text)
				}
			}
			r.partial = nil
			r.discard = false
		}
		if err == io.EOF {
			return replies, nil
		}
		if err != nil && err != bufio.ErrBufferFull {
			return replies, err
		}
	}
}

func nativeFinalReply(provider, sessionID string, line []byte) string {
	var event struct {
		Type, SessionID string
		Payload         struct {
			Type, Role, Phase string
			Content           []struct{ Type, Text string }
		}
		Message struct {
			Role       string
			StopReason string `json:"stop_reason"`
			Content    []struct{ Type, Text string }
		}
	}
	if json.Unmarshal(bytes.TrimSpace(line), &event) != nil {
		return ""
	}
	var parts []string
	if provider == "codex" {
		if event.Type != "response_item" || event.Payload.Type != "message" || event.Payload.Role != "assistant" || event.Payload.Phase != "final_answer" {
			return ""
		}
		for _, c := range event.Payload.Content {
			if c.Type != "output_text" {
				return ""
			}
			parts = append(parts, c.Text)
		}
	} else if provider == "claude" {
		if event.Type != "assistant" || !strings.EqualFold(event.SessionID, sessionID) || event.Message.Role != "assistant" || event.Message.StopReason != "end_turn" && event.Message.StopReason != "stop_sequence" {
			return ""
		}
		for _, c := range event.Message.Content {
			if c.Type == "thinking" || c.Type == "redacted_thinking" {
				continue
			}
			if c.Type != "text" {
				return ""
			}
			parts = append(parts, c.Text)
		}
	} else {
		return ""
	}
	return conciseAgentMessage(strings.Join(parts, "\n"))
}

func (m *model) nativeChatPrompt(repo, text string) string {
	s := m.orchestration[repo]
	if s != nil {
		s.nativePrepared = false
	}
	native, exists := m.state.OrchestratorSessions[repo]
	if s == nil || !exists || native.Config.Provider != s.Provider {
		return text
	}
	if s.nativeReplies == nil {
		reader, err := openNativeReplyReader(native, repo)
		if err != nil {
			return text
		}
		s.nativeReplies = reader
	}
	if len(s.nativeReplies.pendingReplies) > 0 {
		return text
	}
	if err := s.nativeReplies.beginReply(); err != nil {
		s.nativeReplies = nil
		return text
	}
	s.nativePrepared = true
	return "[Fluke: respuesta nativa verificada]\nF2 recibe tu respuesta final directamente, sin update.json. Si podés responder con lo que ya sabés, no uses herramientas. Consultá el contexto o archivos cuando el pedido necesite datos actuales del proyecto; conservá el contrato de acciones para coordinar trabajo.\nMensaje humano: " + text
}

func (m *model) readNativeReplies() {
	for repo, s := range m.orchestration {
		if s.nativeReplies == nil || !s.nativeAwaiting {
			continue
		}
		if len(s.nativeReplies.pendingReplies) == 0 {
			replies, err := s.nativeReplies.replies()
			if err != nil {
				s.nativeReplies = nil
				s.nativeAwaiting = false
				m.notice = localText("Could not read the native reply; F3 shows the session.", "No se pudo leer la respuesta nativa; F3 muestra la sesión.")
				continue
			}
			s.nativeReplies.pendingReplies = replies
		}
		replies := s.nativeReplies.pendingReplies
		if len(replies) == 0 {
			continue
		}
		next := m.state
		for _, text := range replies {
			messages := next.Conversations[repo]
			if len(messages) > 0 {
				last := messages[len(messages)-1]
				if last.Role == "fluke" && last.RunID == s.RunID && last.Text == text {
					continue
				}
			}
			next = withConversation(next, repo, ConversationMessage{Role: "fluke", Text: text, RunID: s.RunID})
		}
		if err := m.store.save(next); err != nil {
			m.notice = uiText("No se pudo guardar el mensaje de Fluke: ") + err.Error()
			continue
		}
		m.state = next
		s.nativeReplies.pendingReplies = nil
		s.nativeAwaiting = false
		s.ReplyStarted = time.Time{}
	}
}

type nativeReplyTick struct{}

// Poll only the conversation while waiting for a native reply. Worker/Git
// reconciliation keeps its existing cadence; idle sessions use no fast timer.
func (m *model) scheduleNativeReplyTick() tea.Cmd {
	if m.nativeReplyTickPending {
		return nil
	}
	for repo, s := range m.orchestration {
		if s.nativeReplies != nil && s.nativeAwaiting && m.sessionAlive("fluke:"+repo) {
			m.nativeReplyTickPending = true
			return tea.Tick(200*time.Millisecond, func(time.Time) tea.Msg { return nativeReplyTick{} })
		}
	}
	return nil
}
