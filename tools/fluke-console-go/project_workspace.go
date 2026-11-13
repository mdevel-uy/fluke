package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func (m *model) taskActions() []string {
	primary := localText("[Start]", "[Iniciar]")
	if tasks := m.projectTasks(); len(tasks) > 0 {
		task := tasks[m.selected%len(tasks)]
		if m.sessionAlive(task.ID) {
			primary = localText("[Session]", "[Sesión]")
		}
		if task.Status == "awaiting_review" || task.Status == "accepted" {
			primary = localText("[Review]", "[Revisar]")
		}
	}
	return []string{primary, localText("[Diff]", "[Diff]"), localText("[Message]", "[Mensaje]")}
}

func (m *model) taskPage(h int) (start, count int) {
	tasks := m.projectTasks()
	count = min(len(tasks), max(1, min(6, h/3)))
	if len(tasks) > 0 {
		start = max(0, m.selected%len(tasks)-count+1)
	}
	return
}

func (m *model) taskPanel(w, h int) string {
	if m.insights {
		return m.planContent(w, h)
	}
	tasks := m.projectTasks()
	if len(tasks) == 0 {
		text := localText("Start with Fluke", "Empezá con Fluke") + "\n\n" + localText("Tell me what you want to build in Chat. We'll agree on the brief before starting workers.", "Contame en Chat qué querés construir. Acordamos el brief antes de iniciar workers.")
		if goal := m.state.Goals[m.repo]; goal.ID != "" {
			text = localText("Agreed goal: ", "Objetivo acordado: ") + goal.Objective + "\n\n" + localText("Fluke will prepare the plan here.", "Fluke va a preparar el plan acá.")
		}
		return wrap(text, w)
	}
	start, count := m.taskPage(h)
	rows := []string{}
	for i := start; i < start+count; i++ {
		task := tasks[i]
		prefix, ink := "  ", cyan
		if i == m.selected%len(tasks) {
			prefix, ink = "› ", pink
		}
		rows = append(rows, strong(ansi.Truncate(fmt.Sprintf("%s%d %s", prefix, i+1, task.Title), w, "…"), ink))
	}
	task := tasks[m.selected%len(tasks)]
	body := strong(status(taskAgentStatus(task)), statusInk(taskAgentStatus(task))) + "\n"
	if task.Queued {
		body += accent(localText("Queued", "En cola"), amber) + "\n"
	}
	body += accent(localText("DONE WHEN", "TERMINADO CUANDO"), cyan) + "\n" + wrap(task.Acceptance, w) + "\n\n"
	if task.AgentMessage != "" {
		body += wrap(task.AgentMessage, w) + "\n"
	}
	if len(task.AgentEvidence) > 0 {
		body += localText("Evidence: ", "Evidencia: ") + strings.Join(task.AgentEvidence, ", ") + "\n"
	}
	if reason := m.dependencyChecks[task.ID]; reason != "" {
		body += wrap(reason, w) + "\n"
	}
	if task.Paused {
		body += wrap(task.Note, w) + "\n"
	}
	lines := strings.Split(wrap(body, w), "\n")
	visible := max(1, h-count-3)
	m.taskScroll = min(max(0, m.taskScroll), max(0, len(lines)-visible))
	separator := rule(w, muted)
	if len(lines) > visible {
		separator = accent(localText("PgUp/PgDn · Details ", "PgUp/PgDn · Detalle ")+fmt.Sprintf("%d/%d", m.taskScroll+1, len(lines)), muted)
	}
	return strings.Join(rows, "\n") + "\n" + separator + "\n" + fit(strings.Join(lines[m.taskScroll:], "\n"), w, visible) + "\n" + accent(strings.Join(m.taskActions(), " "), cyan) + "\n" + accent(localText("[Queue] [Pause] [Agent]", "[Cola] [Pausa] [Agente]"), cyan)
}

func (m *model) clickTaskAction(mouse tea.Mouse) (bool, tea.Cmd) {
	if m.mouseDisabled || m.view != 1 || m.shellProject() || m.config || m.review.open || m.githubOpen || m.command != nil || m.projects.open || m.setup.open || m.quitting || m.workerMessageID != "" || m.insights || mouse.Button != tea.MouseLeft {
		return false, nil
	}
	x, y := mouse.X, mouse.Y-m.headerRows()
	if m.floatingVisible() && inRectangle(x, y, m.floating.bounds) {
		return false, nil
	}
	_, r := m.projectPanels()
	if !inRectangle(x, y, r) || len(m.projectTasks()) == 0 {
		return false, nil
	}
	start, count := m.taskPage(r.h - 4)
	if y >= r.y+3 && y < r.y+3+count {
		m.selected = start + y - r.y - 3
		m.taskScroll = 0
		if m.pane != 2 {
			m.pane = 0
		}
		return true, nil
	}
	key := rune(0)
	if y == r.y+r.h-3 {
		if i := actionAt(x-r.x-2, m.taskActions()); i >= 0 {
			key = []rune{tea.KeyEnter, 'v', 'm'}[i]
			if i == 0 {
				task := m.projectTasks()[m.selected%len(m.projectTasks())]
				if task.Status == "awaiting_review" || task.Status == "accepted" {
					key = 'v'
				}
			}
		}
	}
	if y == r.y+r.h-2 {
		if i := actionAt(x-r.x-2, strings.Fields(localText("[Queue] [Pause] [Agent]", "[Cola] [Pausa] [Agente]"))); i >= 0 {
			key = []rune{'q', 'p', 'a'}[i]
		}
	}
	if key == 0 {
		return false, nil
	}
	m.floating.focused, m.pane = false, 0
	_, cmd := m.Update(tea.KeyPressMsg{Code: key, Text: string(key)})
	return true, cmd
}

func projectActions() []string {
	return []string{"[Chat]", "[Plan]", "[Workers]", "[Balance]"}
}

func (m *model) projectBar() string {
	active := 1
	if m.pane == 1 {
		active = 0
	}
	if m.pane == 2 {
		active = 2
	}
	if m.insights && m.pane == 0 {
		active = 3
	}
	labels := projectActions()
	for i := range labels {
		ink := cyan
		if i == active {
			ink = pink
			labels[i] = ">" + strings.Trim(labels[i], "[]") + "<"
		}
		if i == active {
			labels[i] = strong(labels[i], ink)
		} else {
			labels[i] = accent(labels[i], muted)
		}
	}
	return strings.Join(labels, " ")
}

// Shared by rendering and hit testing: there is only one chat surface per project.
func (m *model) projectPanels() (chat, detail rectangle) {
	if m.shellProject() {
		g := m.shellGeometry()
		return g.chat, g.rail
	}
	w, h := m.width, max(1, m.workspaceHeight()-1)
	if m.floatingVisible() {
		return rectangle{}, rectangle{0, 1, w, h}
	}
	if w < 92 || h < 18 {
		if m.pane == 1 {
			return rectangle{0, 1, w, h}, rectangle{}
		}
		return rectangle{}, rectangle{0, 1, w, h}
	}
	left := w * 60 / 100
	return rectangle{0, 1, left, h}, rectangle{left + 1, 1, w - left - 1, h}
}

func inRectangle(x, y int, r rectangle) bool {
	return r.w > 0 && x >= r.x && x < r.x+r.w && y >= r.y && y < r.y+r.h
}

func actionAt(x int, labels []string) int {
	start := 0
	for i, label := range labels {
		end := start + ansi.StringWidth(label)
		if x >= start && x < end {
			return i
		}
		start = end + 1
	}
	return -1
}

func (m *model) selectProjectPanel(index int) {
	m.insights = index == 3
	m.pane = []int{1, 0, 2, 0}[index]
	if index == 0 && m.floatingVisible() {
		m.floating.focused = true
	}
}

func (m *model) chatRectangle() rectangle {
	if m.floatingVisible() {
		m.clampFloatingChat()
		return m.floating.bounds
	}
	if m.view == 1 && !m.config && !m.githubOpen && !m.review.open {
		r, _ := m.projectPanels()
		return r
	}
	return rectangle{}
}

func (m *model) clickChatAction(mouse tea.Mouse) (bool, tea.Cmd) {
	if m.mouseDisabled || m.view == 1 && m.shellProject() || m.projects.open || m.setup.open || m.quitting || m.command != nil || m.workerMessageID != "" || mouse.Button != tea.MouseLeft {
		return false, nil
	}
	r := m.chatRectangle()
	y := mouse.Y - m.headerRows()
	if !inRectangle(mouse.X, y, r) || y != r.y+r.h-3 {
		return false, nil
	}
	switch actionAt(mouse.X-r.x-2, chatActions()) {
	case 0:
		return true, m.chatKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	case 1:
		if !m.sessionAlive("fluke:" + m.repo) {
			m.notice = localText("Send a message to connect Fluke.", "Enviá un mensaje para conectar Fluke.")
			return true, nil
		}
		m.closePanels()
		m.view, m.home = 2, false
		m.focus("fluke:" + m.repo)
		m.terminals.Mode = terminalMode
		return true, nil
	case 2:
		m.toggleFloatingChat()
		return true, nil
	}
	return false, nil
}

func (m *model) clickWorkspace(mouse tea.Mouse) bool {
	if m.mouseDisabled || m.config || m.githubOpen || m.review.open || m.setup.open || m.projects.open || m.quitting || m.command != nil || m.workerMessageID != "" || mouse.Button != tea.MouseLeft {
		return false
	}
	y := mouse.Y - m.headerRows()
	if m.view == 1 && !m.shellProject() {
		if y == 0 {
			if i := actionAt(mouse.X, projectActions()); i >= 0 {
				m.selectProjectPanel(i)
				return true
			}
		}
		chat, detail := m.projectPanels()
		if inRectangle(mouse.X, y, chat) {
			m.pane = 1
			return true
		}
		if inRectangle(mouse.X, y, detail) {
			if m.pane != 2 {
				m.pane = 0
			}
			return true
		}
	}
	if m.home && m.view == 0 {
		left := m.width
		if m.width >= 92 {
			left = m.width * 40 / 100
		}
		if mouse.X < left {
			if y == 3 {
				m.openProjectEditor(true)
				return true
			}
			if y == 4 {
				m.openProjectEditor(false)
				return true
			}
			page := max(1, (m.workspaceHeight()-7)/6)
			start := max(0, m.selected%max(1, len(m.state.Projects))-page+1)
			index := start + (y-6)/5
			if y >= 6 && index < len(m.state.Projects) && index < start+page {
				m.selected, m.pane = index, 0
				m.homeKey(tea.KeyPressMsg{Code: tea.KeyEnter})
				return true
			}
		}
	}
	return false
}
