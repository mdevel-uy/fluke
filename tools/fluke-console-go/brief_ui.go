package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

func (m *model) briefText() string {
	draft, goal := m.state.DraftGoals[m.repo], m.state.Goals[m.repo]
	sections := []string{}
	if draft.Title != "" {
		sections = append(sections, localText("DRAFT REQUIREMENTS", "REQUISITOS / BORRADOR"), draft.Title,
			localText("REQUIREMENTS AND ACCEPTANCE CRITERIA", "REQUISITOS Y CRITERIOS DE ACEPTACIÓN"), draft.Acceptance)
		if draft.OpenQuestions != "" {
			sections = append(sections, localText("OPEN QUESTIONS", "DUDAS PENDIENTES"), strings.ReplaceAll(draft.OpenQuestions, "? ", "?\n"))
		}
	}
	if index := m.pendingGoalProposal(); index >= 0 {
		d := m.state.Decisions[index]
		sections = append(sections, localText("SCOPE PROPOSED FOR APPROVAL", "ALCANCE PROPUESTO PARA APROBAR"), d.ProposedTitle, d.ProposedAcceptance,
			localText("Enter prepares approval; Enter again confirms. Approving scope prepares tasks; execution is authorized separately in F2.", "Enter prepara la aprobación; otro Enter confirma. Aprobar el alcance prepara las tareas; la ejecución se autoriza por separado en F2."))
	}
	if goal.ID != "" {
		sections = append(sections, localText("AGREED SCOPE", "ALCANCE ACORDADO"), goal.Objective,
			localText("AGREED ACCEPTANCE CRITERIA", "CRITERIOS DE ACEPTACIÓN ACORDADOS"), goal.Acceptance)
	}
	if len(sections) == 0 {
		return localText("NO BRIEF YET\n\nDescribe your project to Fluke in F2. Its requirements, acceptance criteria and open questions will appear here.", "TODAVÍA NO HAY BRIEF\n\nContale tu proyecto a Fluke en F2. Los requisitos, criterios de aceptación y dudas pendientes aparecerán acá.")
	}
	return strings.Join(sections, "\n\n")
}

func readPane(text string, w, rows int, offset *int) string {
	lines := strings.Split(wrap(text, w), "\n")
	rows = max(1, rows-1)
	*offset = min(max(0, *offset), max(0, len(lines)-rows))
	end := min(len(lines), *offset+rows)
	return fit(strings.Join(lines[*offset:end], "\n"), w, rows) + "\n" +
		accent(fmt.Sprintf(localText("Lines %d–%d / %d · PgUp/PgDn", "Líneas %d–%d / %d · PgUp/PgDn"), *offset+1, end, len(lines)), muted)
}

func (m *model) decisionsContent(w, h int) string {
	indices := []int{}
	selected := m.selectedDecision()
	for i, d := range m.state.Decisions {
		if d.Repo == m.repo {
			indices = append(indices, i)
		}
	}
	if len(indices) == 0 {
		return wrap(localText("No recorded decisions. Pending brief questions are shown in the brief. Continue in F2 to clarify them.", "Sin decisiones registradas. Las dudas del brief aparecen en el borrador. Seguí en F2 para aclararlas."), w)
	}
	listRows := min(len(indices), max(1, h/4))
	start := min(max(0, m.selected-listRows+1), max(0, len(indices)-listRows))
	lines := []string{}
	for _, i := range indices[start:min(len(indices), start+listRows)] {
		d := m.state.Decisions[i]
		marker := "  ? "
		if d.Answer != nil {
			marker = "  ✓ "
		}
		if i == selected {
			marker = "> " + marker[2:]
		}
		title := d.Question
		if d.ProposedTitle != "" {
			title = d.ProposedTitle
		}
		lines = append(lines, fmt.Sprintf("%s%02d %s", marker, i+1, strings.Split(title, "\n")[0]))
	}
	if selected < 0 {
		return strings.Join(lines, "\n")
	}
	d := m.state.Decisions[selected]
	help := localText("Ctrl+D: answer in F2 · ↑/↓: choose", "Ctrl+D: responder en F2 · ↑/↓: elegir")
	if d.ProposedTitle != "" && d.Answer == nil {
		help = localText("Enter: approve · r: reject · Ctrl+D: F2", "Enter: aprobar · r: rechazar · Ctrl+D: F2")
	}
	text := d.Question
	if d.Answer != nil {
		help = localText("Enter: correct answer · C: chat in F2", "Enter: corregir respuesta · C: chat en F2")
		if d.ProposedTitle != "" {
			help = localText("Scope changes are discussed in F2 · C: chat", "Los cambios de alcance se conversan en F2 · C: chat")
		}
		text += "\n\n" + localText("ANSWER: ", "RESPUESTA: ") + *d.Answer
	}
	return fit(strings.Join(lines, "\n"), w, listRows) + "\n" + accent(help, cyan) + "\n" +
		readPane(text, w, max(1, h-listRows-2), &m.decisionScroll)
}

func (m *model) decisionsView(w, h int) string {
	brief := func(width int) string {
		return frame(localText("BRIEF / REQUIREMENTS", "BRIEF / REQUISITOS"), readPane(m.briefText(), width-4, h-4, &m.briefScroll), width, h, cyan, m.pane == 0)
	}
	decisions := func(width int) string {
		return frame(localText("DECISIONS / HISTORY", "DECISIONES / HISTORIAL"), m.decisionsContent(width-4, h-4), width, h, cyan, m.pane == 1)
	}
	if w < 104 || m.panelMaximized {
		if m.pane == 1 {
			return decisions(w)
		}
		return brief(w)
	}
	left := w * 2 / 3
	return lipgloss.JoinHorizontal(lipgloss.Top, brief(left), " ", decisions(w-left-1))
}

func (m *model) briefKey(key string) (bool, tea.Cmd) {
	if key == "c" || key == "ctrl+d" {
		index := m.selectedDecision()
		if key == "ctrl+d" && index >= 0 && m.state.Decisions[index].Answer != nil {
			m.notice = localText("This decision is already answered. Enter prepares a correction.", "Esta decisión ya tiene respuesta. Enter prepara una corrección.")
			return true, nil
		}
		m.globalKey("f2")
		m.pane = 1
		if key == "ctrl+d" && index >= 0 {
			m.chatDecision = index + 1
		}
		return true, nil
	}
	if key == "tab" || key == "shift+tab" {
		if !m.panelMaximized {
			m.pane = (m.pane + 1) % 2
		}
		return true, nil
	}
	if key == "pgup" || key == "pgdown" || m.pane == 0 && (key == "up" || key == "down" || key == "home" || key == "end") {
		offset := &m.briefScroll
		if m.pane == 1 {
			offset = &m.decisionScroll
		}
		delta := max(1, m.workspaceHeight()-6)
		if key == "up" || key == "down" {
			delta = 1
		}
		if key == "pgup" || key == "up" {
			*offset = max(0, *offset-delta)
		} else {
			*offset += delta
		}
		if key == "home" {
			*offset = 0
		}
		if key == "end" {
			*offset = 1 << 30
		}
		return true, nil
	}
	if m.pane == 0 {
		if key == "enter" {
			if i := m.pendingGoalProposal(); i >= 0 {
				line := fmt.Sprintf("approve %d", i+1)
				m.command = &line
			} else {
				m.notice = localText("Continue in F2 to clarify the draft. There is no pending scope proposal to approve.", "Seguí en F2 para aclarar el borrador. No hay una propuesta de alcance pendiente para aprobar.")
			}
		}
		return true, nil
	}
	if key == "up" || key == "down" || key == "j" || key == "k" {
		count := 0
		for _, d := range m.state.Decisions {
			if d.Repo == m.repo {
				count++
			}
		}
		if count > 0 {
			if key == "up" || key == "k" {
				m.selected = max(0, m.selected-1)
			} else {
				m.selected = min(count-1, m.selected+1)
			}
		}
		m.decisionScroll = 0
		return true, nil
	}
	if key == "enter" && m.pane == 1 {
		if i := m.selectedDecision(); i >= 0 && m.state.Decisions[i].Answer != nil && m.state.Decisions[i].ProposedTitle != "" {
			m.notice = localText("Discuss a scope change in F2; the recorded approval stays in history.", "Conversá un cambio de alcance en F2; la aprobación registrada queda en el historial.")
			return true, nil
		}
	}
	return false, nil
}
