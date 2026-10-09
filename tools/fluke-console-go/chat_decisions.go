package main

import (
	"fmt"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
)

func (m *model) pendingChatDecision() int {
	if index := m.pendingGoalProposal(); index >= 0 {
		return index
	}
	for i := len(m.state.Decisions) - 1; i >= 0; i-- {
		d := m.state.Decisions[i]
		if d.Repo == m.repo && d.Answer == nil && !d.DirectInstruction {
			return i
		}
	}
	return -1
}

func (m *model) reviewedChatDecision() int {
	i := m.chatDecision - 1
	if i >= 0 && i < len(m.state.Decisions) {
		d := m.state.Decisions[i]
		if d.Repo == m.repo && d.Answer == nil {
			return i
		}
	}
	return -1
}

// Explicit replies only: a message that proposes changes is still ordinary
// conversation, rather than an approval inferred from a substring.
func proposalChatReply(text string) (approved, recognized bool) {
	switch strings.Trim(strings.ToLower(strings.TrimSpace(text)), ".!¡ ") {
	case "apruebo", "aprobado", "aprobar", "approve", "approved", "sí", "si", "yes", "dale":
		return true, true
	case "rechazo", "rechazado", "rechazar", "reject", "rejected", "no":
		return false, true
	}
	return false, false
}

func (m *model) chatDecisionKey(key string) (bool, tea.Cmd) {
	if key == "enter" {
		switch strings.ToLower(strings.TrimSpace(m.chatDraft[m.repo])) {
		case "ver brief", "leer brief", "mostrar brief", "show brief", "read brief":
			m.chatDraft[m.repo] = ""
			m.markConversationDraft()
			return m.globalKey("f4")
		}
	}
	if key == "ctrl+d" {
		if m.chatDecision != 0 {
			m.chatDecision, m.chatDecisionScroll = 0, 0
		} else if index := m.pendingChatDecision(); index >= 0 {
			m.chatDecision, m.chatDecisionScroll = index+1, 0
		}
		return true, nil
	}
	index := m.reviewedChatDecision()
	if key == "enter" && (index < 0 || m.state.Decisions[index].ProposedTitle == "") {
		switch strings.ToLower(strings.TrimSpace(m.chatDraft[m.repo])) {
		case "ejecutar plan", "run plan":
			return true, m.runChatPlan()
		}
	}
	if index >= 0 {
		switch key {
		case "esc":
			m.chatDecision, m.chatDecisionScroll = 0, 0
			return true, nil
		case "up", "pgup":
			m.chatDecisionScroll = max(0, m.chatDecisionScroll-1)
			return true, nil
		case "down", "pgdown":
			m.chatDecisionScroll++
			return true, nil
		}
	} else {
		m.chatDecision = 0
	}
	if key != "enter" || index < 0 {
		return false, nil
	}
	text := m.chatDraft[m.repo]
	if strings.TrimSpace(text) == "" {
		return true, nil
	}
	d := m.state.Decisions[index]
	var cmd tea.Cmd
	if d.ProposedTitle != "" {
		approved, recognized := proposalChatReply(text)
		if !recognized {
			// Leave review before passing edits/questions to the conversational
			// agent. Never interpret "yes, but change X" as an approval.
			m.chatDecision, m.chatDecisionScroll = 0, 0
			return false, nil
		}
		cmd = m.resolveProposalReply(strconv.Itoa(index+1), approved, text)
	} else {
		next := m.state
		next.Decisions = append([]Decision{}, next.Decisions...)
		next.Decisions[index].Answer = &text
		if d.TaskID != "" {
			next.Decisions[index].Continuation = "pending"
		}
		next = withConversation(next, d.Repo, ConversationMessage{Role: "human", Text: text, RunID: d.RunID, Delivery: "sent"})
		next = withConversation(next, d.Repo, ConversationMessage{Role: "fluke", Text: localText("Answer saved. Fluke can continue.", "Respuesta guardada. Fluke puede continuar."), RunID: d.RunID})
		if m.saveEdit(next, localText("Answer saved.", "Respuesta guardada.")) {
			cmd = tea.Batch(m.continueAnsweredWorkers(), m.scheduleWorkerTick())
		}
	}
	if m.state.Decisions[index].Answer != nil {
		m.chatDraft[m.repo] = ""
		m.chatDecision, m.chatDecisionScroll, m.chatScroll = 0, 0, 0
		m.markConversationDraft()
		if approvedGoal := d.ProposedGoal && m.state.Decisions[index].Answer != nil && *m.state.Decisions[index].Answer == "aprobada"; approvedGoal && !m.sessionAlive("fluke:"+m.repo) && m.state.Orchestrator != nil {
			// A saved proposal can outlive its CLI. Resume planning after the
			// human approves it instead of leaving the scope silently idle.
			cmd = tea.Batch(cmd, m.start(""))
		}
	}
	return true, cmd
}

func (m *model) runChatPlan() tea.Cmd {
	goal := m.state.Goals[m.repo]
	if goal.ID == "" || m.state.PausedProjects[m.repo] {
		m.notice = localText("Agree on the scope and resume the project before running its plan.", "Acordá el alcance y reanudá el proyecto antes de ejecutar su plan.")
		return nil
	}
	next := m.state
	next.Tasks = append([]Task{}, next.Tasks...)
	count := 0
	for i, task := range next.Tasks {
		if task.Repo == m.repo && task.GoalID == goal.ID && task.Status == "pending" && task.AwaitingExecution && !task.Paused {
			next.Tasks[i].AwaitingExecution, next.Tasks[i].Queued = false, true
			count++
		}
	}
	if count == 0 {
		m.notice = localText("There are no new plan tasks waiting for execution approval.", "No hay tareas nuevas del plan esperando aprobación para ejecutarse.")
		return nil
	}
	next = withConversation(next, m.repo, ConversationMessage{Role: "human", Text: m.chatDraft[m.repo], Delivery: "sent"})
	message := fmt.Sprintf(localText("Execution approved: %d task(s) queued. Dependencies and worker capacity still apply.", "Ejecución aprobada: %d tarea(s) en cola. Se respetan las dependencias y el cupo de workers."), count)
	next = withConversation(next, m.repo, ConversationMessage{Role: "fluke", Text: message})
	if !m.saveEdit(next, message) {
		return nil
	}
	m.chatDraft[m.repo] = ""
	m.chatDecision, m.chatDecisionScroll, m.chatScroll = 0, 0, 0
	m.markConversationDraft()
	return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
}

func (m *model) chatDecisionContent(w, h int) string {
	i := m.reviewedChatDecision()
	if i < 0 {
		return ""
	}
	d := m.state.Decisions[i]
	title := fmt.Sprintf(localText("DECISION %d", "DECISIÓN %d"), i+1)
	text := d.Question
	if d.ProposedTitle != "" {
		kind := localText("TASK / approval queues its worker", "TAREA / aprobar encola su worker")
		if d.ProposedGoal {
			kind = localText("SCOPE / approval prepares the plan", "ALCANCE / aprobar prepara el plan")
		}
		text = kind + "\n\n" + d.ProposedTitle + "\n\n" + d.ProposedAcceptance
	}
	lines := strings.Split(wrap(text, w), "\n")
	rows := max(1, h-2)
	start := min(m.chatDecisionScroll, max(0, len(lines)-rows))
	m.chatDecisionScroll = start
	help := localText("Type your answer · Enter sends · Esc returns", "Escribí tu respuesta · Enter envía · Esc vuelve")
	if d.ProposedTitle != "" {
		help = localText("Type approve / reject · Enter confirms", "Escribí apruebo / rechazo · Enter confirma")
	}
	return strong(title, amber) + "\n" + fit(strings.Join(lines[start:min(len(lines), start+rows)], "\n"), w, rows) + "\n" + wrap(help, w)
}

func (m *model) hasPendingPlanExecution() bool {
	goal := m.state.Goals[m.repo]
	for _, task := range m.state.Tasks {
		if goal.ID != "" && task.Repo == m.repo && task.GoalID == goal.ID && task.Status == "pending" && task.AwaitingExecution {
			return true
		}
	}
	return false
}
