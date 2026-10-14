package main

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// F3 in the shell: a side panel with every live session and, for the focused
// one, what it is for, what it is doing and what it last said, next to the
// terminal itself. The terminals keep all their behaviour; they just live in
// the area to the right of the panel.

const sessionsMinWidth = 110

func (m *model) sessionsPanelWidth() int {
	if !m.shellMode() || m.width < sessionsMinWidth {
		return 0
	}
	if m.width >= 150 {
		return 42
	}
	return 36
}

// Terminals are laid out in the area the panel leaves, whatever the view.
func (m *model) fitTerminals() {
	w, h := m.width-m.sessionsPanelWidth(), m.workspaceHeight()
	if m.terminals.width != w || m.terminals.height != h {
		m.terminals.Update(tea.WindowSizeMsg{Width: w, Height: h})
	}
}

func (m *model) sessionKey(w *terminalWindow) string {
	for key, id := range m.sessions {
		if id == w.ID {
			return key
		}
	}
	return ""
}

func (m *model) taskByID(id string) (Task, bool) {
	for _, t := range m.state.Tasks {
		if t.ID == id {
			return t, true
		}
	}
	return Task{}, false
}

// Last lines the session printed, for "what is it doing" at a glance.
func recentOutput(w *terminalWindow, n int) []string {
	content, _ := renderTerminal(w)
	var lines []string
	for _, line := range strings.Split(ansi.Strip(content), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func (m *model) sessionsView(terminal string, w, h int) string {
	pw := m.sessionsPanelWidth()
	if pw == 0 {
		return terminal
	}
	left := m.sessionsPanel(pw, h)
	right := strings.Split(fit(terminal, w-pw, h), "\n")
	out := make([]string, h)
	for i := range out {
		out[i] = left[i] + right[i]
	}
	return strings.Join(out, "\n")
}

type sessionHit struct{ window int }

func (m *model) sessionsPanel(pw, h int) []string {
	inner := max(8, pw-2)
	visible := m.terminals.visibleWindows()
	var lines []string
	var hits []sessionHit
	add := func(text string, hit sessionHit) {
		lines = append(lines, text)
		hits = append(hits, hit)
	}
	none := sessionHit{-1}
	add(strong(localText("SESSIONS", "SESIONES"), cyan)+accent(fmt.Sprintf(" · %d", len(visible)), muted), none)

	// List: two rows per session, the focused one always visible.
	listRows := min(len(visible), max(1, (h-14)/2))
	focusAt := 0
	for n, index := range visible {
		if index == m.terminals.FocusedWindow {
			focusAt = n
		}
	}
	first := max(0, min(focusAt-listRows+1, len(visible)-listRows))
	for n := first; n < first+listRows && n < len(visible); n++ {
		index := visible[n]
		win := m.terminals.Windows[index]
		key := m.sessionKey(win)
		name, meta, glyph, ink := win.Name, "", "·", muted
		if task, ok := m.taskByID(key); ok {
			g, c := taskGlyph(task)
			glyph, ink = g, c
			name = task.Title
			meta = shellStatusWord(taskAgentStatus(task))
			if label := taskModelLabel(task); label != "—" {
				meta += " · " + label
			}
		} else if strings.HasPrefix(key, "fluke:") {
			glyph, ink = "≋", pink
			name = localText("Fluke · ", "Fluke · ") + filepath.Base(strings.TrimPrefix(key, "fluke:"))
			meta = localText("orchestrator", "orquestador")
		}
		if win.ProcessExited() {
			meta = localText("exited", "salió")
		}
		mark := "  "
		title := accent(ansi.Truncate(name, max(1, inner-5), "…"), foreground)
		if index == m.terminals.FocusedWindow {
			mark = "› "
			title = strong(ansi.Truncate(name, max(1, inner-5), "…"), foreground)
		}
		add(" "+accent(mark, pink)+accent(glyph, ink)+" "+title, sessionHit{index})
		add("     "+accent(ansi.Truncate(meta, max(1, inner-5), "…"), muted), sessionHit{index})
	}
	if extra := len(visible) - listRows; extra > 0 {
		add("   "+accent(fmt.Sprintf(localText("+%d more · Tab", "+%d más · Tab"), extra), muted), none)
	}
	add("", none)
	add(accent(strings.Repeat("─", inner), borderInk), none)

	// Detail of the focused session.
	if m.terminals.FocusedWindow >= 0 && m.terminals.FocusedWindow < len(m.terminals.Windows) && len(visible) > 0 {
		win := m.terminals.Windows[m.terminals.FocusedWindow]
		for _, l := range m.sessionDetail(win, inner-1, h-len(lines)) {
			add(" "+l, none)
		}
	}

	m.sessionHits = hits
	sep := accent("│", borderInk)
	out := make([]string, h)
	for i := range out {
		body := ""
		if i < len(lines) {
			body = lines[i]
		}
		out[i] = fit(body, pw-1, 1) + sep
	}
	return out
}

func (m *model) sessionDetail(win *terminalWindow, w, rows int) []string {
	var lines []string
	para := func(text string, max int, ink func(string) string) {
		for i, l := range strings.Split(wrap(text, w), "\n") {
			if i >= max {
				lines[len(lines)-1] = ansi.Truncate(lines[len(lines)-1], w-1, "") + "…"
				break
			}
			lines = append(lines, ink(l))
		}
	}
	plain := func(s string) string { return s }
	dim := func(s string) string { return accent(s, muted) }
	heading := func(text string) { lines = append(lines, strong(text, cyan)) }
	key := m.sessionKey(win)

	if task, ok := m.taskByID(key); ok {
		glyph, ink := taskGlyph(task)
		lines = append(lines, accent(glyph+" ", ink)+strong(ansi.Truncate(task.Title, max(1, w-2), "…"), foreground))
		meta := []string{shellStatusWord(taskAgentStatus(task))}
		if label := taskModelLabel(task); label != "—" {
			meta = append(meta, label)
		}
		lines = append(lines, accent(strings.Join(meta, " · "), ink))
		facts := []string{filepath.Base(task.Repo)}
		if task.Branch != "" {
			facts = append(facts, shortBranch(task.Branch))
		}
		if task.Metrics.ObservedMS > 0 {
			facts = append(facts, metricsDuration(task.Metrics.ObservedMS))
		}
		tokens, cost := taskUsageSummary(task)
		facts = append(facts, tokens+" tok", cost)
		para(strings.Join(facts, " · "), 2, dim)
		lines = append(lines, "")
		if task.AgentMessage != "" {
			heading(localText("WHAT IT REPORTED", "LO ÚLTIMO QUE REPORTÓ"))
			para(conciseAgentMessage(task.AgentMessage), 5, plain)
			lines = append(lines, "")
		}
		if out := recentOutput(win, 4); len(out) > 0 {
			heading(localText("RECENT OUTPUT", "SALIDA RECIENTE"))
			for _, l := range out {
				lines = append(lines, accent(ansi.Truncate(l, w, "…"), muted))
			}
			lines = append(lines, "")
		}
		if task.Acceptance != "" {
			heading(localText("DONE WHEN", "TERMINADO CUANDO"))
			para(task.Acceptance, 4, plain)
			lines = append(lines, "")
		}
		if len(task.AgentEvidence) > 0 {
			heading(localText("EVIDENCE", "EVIDENCIA"))
			para(strings.Join(task.AgentEvidence, ", "), 2, dim)
			lines = append(lines, "")
		}
		if reason := m.dependencyChecks[task.ID]; reason != "" {
			heading(localText("WAITING ON", "ESPERA"))
			para(cleanAgentText(reason), 3, func(s string) string { return accent(s, amber) })
		}
	} else if strings.HasPrefix(key, "fluke:") {
		repo := strings.TrimPrefix(key, "fluke:")
		lines = append(lines, strong(localText("Orchestrator", "Orquestador"), pink)+accent(" · "+filepath.Base(repo), muted))
		if s := m.orchestration[repo]; s != nil {
			lines = append(lines, accent(configLabel(&s.Config), muted))
		}
		s := summarizeProject(m.state, repo)
		lines = append(lines, accent(fmt.Sprintf(localText("%d/%d accepted · %d to review · %d blocked", "%d/%d aceptadas · %d por revisar · %d bloqueadas"), s.Accepted, s.Total, s.Reviewing, s.Blocked), muted), "")
		if goal := m.state.Goals[repo]; goal.ID != "" {
			heading(localText("GOAL", "OBJETIVO"))
			para(goal.Objective, 3, plain)
			lines = append(lines, "")
		}
		if out := recentOutput(win, 5); len(out) > 0 {
			heading(localText("RECENT OUTPUT", "SALIDA RECIENTE"))
			for _, l := range out {
				lines = append(lines, accent(ansi.Truncate(l, w, "…"), muted))
			}
		}
	} else {
		lines = append(lines, strong(ansi.Truncate(win.Name, w, "…"), foreground))
		for _, l := range recentOutput(win, 6) {
			lines = append(lines, accent(ansi.Truncate(l, w, "…"), muted))
		}
	}
	if len(lines) > rows && rows > 0 {
		lines = lines[:rows]
	}
	return lines
}

// Clicks on the panel focus a session; everything else belongs to the terminals.
func (m *model) clickSessions(mouse tea.Mouse) bool {
	pw := m.sessionsPanelWidth()
	if pw == 0 || m.view != 2 || m.mouseDisabled || m.config || m.githubOpen || m.review.open || m.projects.open || m.quitting || m.command != nil || m.workerMessageID != "" || m.switcher != nil {
		return false
	}
	if mouse.Button != tea.MouseLeft || mouse.X >= pw || mouse.Y < m.headerRows() || mouse.Y >= m.height-m.footerRows() {
		return false
	}
	if row := mouse.Y - m.headerRows(); row >= 0 && row < len(m.sessionHits) && m.sessionHits[row].window >= 0 {
		m.terminals.FocusWindow(m.sessionHits[row].window)
		m.terminals.layout()
	}
	return true
}

// Title bar of a terminal window: what the session is for and how it is going,
// so every tile says something even when it is not the focused one.
func (m *model) windowTitle(w *terminalWindow) string {
	key := m.sessionKey(w)
	if task, ok := m.taskByID(key); ok {
		glyph, _ := taskGlyph(task)
		parts := []string{glyph + " " + task.Title, shellStatusWord(taskAgentStatus(task))}
		if label := taskModelLabel(task); label != "—" {
			parts = append(parts, label)
		}
		if task.Metrics.ObservedMS > 0 {
			parts = append(parts, metricsDuration(task.Metrics.ObservedMS))
		}
		tokens, cost := taskUsageSummary(task)
		if tokens != "—" {
			parts = append(parts, tokens+" tok")
		}
		if cost != "—" {
			parts = append(parts, cost)
		}
		return strings.Join(parts, " · ")
	}
	if strings.HasPrefix(key, "fluke:") {
		return "≋ Fluke · " + filepath.Base(strings.TrimPrefix(key, "fluke:")) + " · " + localText("orchestrator", "orquestador")
	}
	return ""
}
