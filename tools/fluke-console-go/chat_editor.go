package main

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func (m *model) chatPosition() int {
	n := len([]rune(m.chatDraft[m.repo]))
	return n - min(n, m.chatCaret[m.repo])
}

func (m *model) setChatPosition(pos int) {
	if m.chatCaret == nil {
		m.chatCaret = map[string]int{}
	}
	n := len([]rune(m.chatDraft[m.repo]))
	m.chatCaret[m.repo] = n - max(0, min(pos, n))
}

func (m *model) insertChat(text string) {
	text = cleanAgentText(strings.NewReplacer("\r", "", "\t", "    ").Replace(text))
	if len(m.chatDraft[m.repo])+len(text) > 16000 {
		m.notice = localText("Message limit: 16 KB. Reference a file for longer context.", "Límite del mensaje: 16 KB. Referenciá un archivo para contexto más largo.")
		return
	}
	r, pos := []rune(m.chatDraft[m.repo]), m.chatPosition()
	m.chatDraft[m.repo] = string(r[:pos]) + text + string(r[pos:])
	m.setChatPosition(pos + len([]rune(text)))
	m.markConversationDraft()
}

func (m *model) chatKey(v tea.KeyPressMsg) tea.Cmd {
	r, pos := []rune(m.chatDraft[m.repo]), m.chatPosition()
	switch v.String() {
	case "enter":
		m.chatScroll = 0
		if strings.TrimSpace(string(r)) == "" {
			m.notice = localText("Write what you want to build, change or ask.", "Escribí qué querés construir, cambiar o preguntar.")
			return nil
		}
		if !m.sessionAlive("fluke:" + m.repo) {
			return m.start("")
		}
		return m.sendChat(string(r))
	case "shift+enter", "alt+enter", "ctrl+j":
		m.insertChat("\n")
		return nil
	case "left":
		pos--
	case "right":
		pos++
	case "ctrl+home":
		pos = 0
	case "ctrl+end":
		pos = len(r)
	case "home", "ctrl+a":
		for pos > 0 && r[pos-1] != '\n' {
			pos--
		}
	case "end", "ctrl+e":
		for pos < len(r) && r[pos] != '\n' {
			pos++
		}
	case "up", "down":
		width := max(1, m.chatRectangle().w-9)
		_, points := layoutChat(r, width)
		point := points[pos]
		target := point.row - 1
		if v.String() == "down" {
			target = point.row + 1
		}
		for i, p := range points {
			if p.row == target && p.col <= point.col {
				pos = i
			}
		}

	case "backspace":
		if pos > 0 {
			r = append(r[:pos-1], r[pos:]...)
			pos--
		}
	case "delete":
		if pos < len(r) {
			r = append(r[:pos], r[pos+1:]...)
		}
	case "ctrl+u":
		r, pos = nil, 0
	case "pgup":
		m.scrollChat(max(1, m.workspaceHeight()/2))
		return nil
	case "pgdown":
		m.scrollChat(-max(1, m.workspaceHeight()/2))
		return nil
	default:
		m.insertChat(v.Text)
		return nil
	}
	m.chatDraft[m.repo] = string(r)
	m.setChatPosition(pos)
	m.markConversationDraft()
	return nil
}

func (m *model) scrollChat(delta int) {
	r := m.chatRectangle()
	w, h := max(1, r.w-4), max(1, r.h-4)
	rows := max(1, h-min(3, max(1, h-8))-6)
	if m.view == 1 && m.shellProject() {
		rows = m.shellGeometry().rows
	}
	limit := max(0, len(brandTranscriptLines(m.state.Conversations[m.repo], w))-rows)
	m.chatScroll = max(0, min(limit, m.chatScroll+delta))
}

type chatPoint struct{ row, col int }
type chatLine struct{ start, end int }

func layoutChat(r []rune, width int) ([]chatLine, []chatPoint) {
	width = max(1, width)
	lines := []chatLine{{}}
	points := make([]chatPoint, len(r)+1)
	col := 0
	for i, c := range r {
		size := ansi.StringWidth(string(c))
		if c != '\n' && col+size > width && col > 0 {
			lines = append(lines, chatLine{i, i})
			col = 0
		}
		points[i] = chatPoint{len(lines) - 1, col}
		if c == '\n' {
			lines[len(lines)-1].end = i
			lines = append(lines, chatLine{i + 1, i + 1})
			col = 0
			continue
		}
		lines[len(lines)-1].end = i + 1
		col += size
	}
	points[len(r)] = chatPoint{len(lines) - 1, col}
	return lines, points
}

// Rendering and arrow navigation share the same visual rows.
func (m *model) chatEditor(w, rows int, focused bool) string {
	w, rows = max(1, w), max(1, rows)
	r, pos := []rune(m.chatDraft[m.repo]), m.chatPosition()
	spans, points := layoutChat(r, max(1, w-5))
	caretRow := points[pos].row
	lines := make([]string, len(spans))
	for i, span := range spans {
		lines[i] = string(r[span.start:span.end])
		if focused && i == caretRow {
			lines[i] = string(r[span.start:pos]) + accent("▌", cyan) + string(r[pos:span.end])
		}
	}
	if len(r) == 0 {
		lines[0] += accent(localText("Tell Fluke what you need…", "Contale a Fluke qué necesitás…"), muted)
	}
	start := max(0, caretRow-rows+1)
	ink := borderInk
	if focused {
		ink = pink
	}
	out := []string{accent("┌"+strings.Repeat("─", max(0, w-2))+"┐", ink)}
	for _, line := range strings.Split(fit(strings.Join(lines[start:], "\n"), max(1, w-4), rows), "\n") {
		out = append(out, accent("│", ink)+" "+line+" "+accent("│", ink))
	}
	out = append(out, accent("└"+strings.Repeat("─", max(0, w-2))+"┘", ink))
	return strings.Join(out, "\n")
}

func chatActions() []string {
	return []string{localText("[Send]", "[Enviar]"), localText("[Connection]", "[Conexión]"), localText("[Pin]", "[Fijar]")}
}

func (m *model) chatBody(w, h int, focused bool) string {
	inside, bodyRows := max(1, w-4), max(1, h-4)
	inputRows := min(3, max(1, bodyRows-8))
	transcriptRows := max(1, bodyRows-inputRows-6)
	messages := m.projectMessages()
	status, hint := m.sessionSummary()
	if m.chatScroll > 0 {
		status = localText("HISTORY · PgDn for recent messages", "HISTORIAL · PgDn para volver")
	}
	return fit(conversationTranscriptAt(messages, inside, transcriptRows, m.chatScroll), inside, transcriptRows) + "\n" +
		fit(accent(status, cyan)+"\n"+accent(hint, muted), inside, 2) + "\n" +
		m.chatEditor(inside, inputRows, focused) + "\n" + accent(strings.Join(chatActions(), " "), cyan) + "\n" +
		accent(ansi.Truncate(localText("Enter send · Alt+Enter new line", "Enter envía · Alt+Enter nueva línea"), inside, ""), muted)
}
