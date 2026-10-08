package main

import (
	"fmt"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
)

func (m *model) latestWorkerInstruction(task Task) (Decision, bool) {
	for i := len(m.state.Decisions) - 1; i >= 0; i-- {
		d := m.state.Decisions[i]
		if d.TaskID == task.ID && d.RunID == task.AgentRun && d.HumanInstructionSeq != 0 {
			return d, true
		}
	}
	return Decision{}, false
}

func workerContext(state State, task Task) any {
	decisions := []Decision{}
	for i, d := range state.Decisions {
		if d.TaskID == task.ID {
			d.Number = i + 1
			decisions = append(decisions, d)
		}
	}
	return struct {
		Task      Task
		Decisions []Decision
		Language  string `json:"language"`
	}{task, decisions, state.Language}
}

func (m *model) refreshWorkerContexts() {
	for _, task := range m.state.Tasks {
		if task.Worktree == nil || task.AgentRun == "" || !m.sessionAlive(task.ID) {
			continue
		}
		if err := atomicJSON(workerSignalPath(*task.Worktree, task.ID, task.AgentRun, "context"), workerContext(m.state, task)); err != nil {
			m.notice = localText("Saved state; worker context could not be refreshed: ", "Estado guardado; no se pudo actualizar el contexto del worker: ") + err.Error()
		}
	}
}

func (m *model) openWorkerMessage(id string) {
	if id == "" && len(m.terminals.Windows) > 0 {
		window := m.terminals.Windows[m.terminals.FocusedWindow]
		for _, task := range m.state.Tasks {
			if m.sessions[task.ID] == window.ID {
				id = task.ID
				m.repo = task.Repo
				break
			}
		}
	}
	if id == "" {
		m.notice = localText("Select a worker to message. Use Fluke's conversation for the orchestrator.", "Elegí un worker para escribirle. Usá la conversación de Fluke para el orquestador.")
		return
	}
	m.workerMessageID = id
	m.focus(id)
	m.view, m.terminals.Mode = 2, windowMode
	if w := m.terminalFor(id); w != nil {
		w.conversationPending.Store(true)
	}
	m.notice = localText("Your message is saved for the worker and the orchestrator. Enter sends; Esc cancels.", "El mensaje queda guardado para el worker y el orquestador. Enter envía; Esc cancela.")
}

func (m *model) closeWorkerMessage() {
	if m.workerMessageID != "" && m.terminals != nil {
		if w := m.terminalFor(m.workerMessageID); w != nil {
			w.conversationPending.Store(false)
		}
	}
	m.workerMessageID = ""
}

func (m *model) editWorkerMessage(key tea.KeyPressMsg) tea.Cmd {
	id := m.workerMessageID
	switch key.String() {
	case "esc":
		m.closeWorkerMessage()
	case "enter":
		before := len(m.state.Decisions)
		m.closeWorkerMessage()
		cmd := m.sendWorkerMessage(id, m.chatDraft[id])
		if len(m.state.Decisions) > before {
			m.chatDraft[id] = ""
		} else {
			m.workerMessageID = id
			if w := m.terminalFor(id); w != nil {
				w.conversationPending.Store(true)
			}
		}
		return cmd
	case "backspace":
		runes := []rune(m.chatDraft[id])
		if len(runes) > 0 {
			m.chatDraft[id] = string(runes[:len(runes)-1])
		}
	case "ctrl+u":
		m.chatDraft[id] = ""
	case "shift+enter":
		if len(m.chatDraft[id]) < 4000 {
			m.chatDraft[id] += "\n"
		}
	default:
		if key.Text != "" && len(m.chatDraft[id])+len(key.Text) <= 4000 {
			m.chatDraft[id] += key.Text
		}
	}
	return nil
}

func (m *model) sendWorkerMessage(id, text string) tea.Cmd {
	return m.saveWorkerInstruction(id, text, Decision{DirectInstruction: true, Question: localText("Direct message to worker", "Mensaje directo al worker")}, -1)
}

func (m *model) amendDecision(rest string) tea.Cmd {
	number, text, _ := strings.Cut(rest, " ")
	n, err := strconv.Atoi(number)
	text = strings.TrimSpace(text)
	if err != nil || n < 1 || n > len(m.state.Decisions) || text == "" || len(text) > 4000 {
		m.notice = localText("Use :amend N corrected answer (up to 4000 bytes).", "Usá :amend N respuesta corregida (hasta 4000 bytes).")
		return nil
	}
	d := m.state.Decisions[n-1]
	if d.Answer == nil || d.ProposedTitle != "" {
		m.notice = localText("Amend an answered decision. Scope/task proposals use a new proposal.", "Corregí una decisión respondida. Las propuestas de alcance/tarea requieren otra propuesta.")
		return nil
	}
	for _, later := range m.state.Decisions[n:] {
		if later.Supersedes == n {
			m.notice = localText("This answer already has a correction. Select its latest version.", "Esta respuesta ya tiene una corrección. Elegí su última versión.")
			return nil
		}
	}
	d.Supersedes, d.Continuation = n, ""
	d.Number = len(m.state.Decisions) + 1
	d.Answer = &text
	if d.TaskID != "" {
		return m.saveWorkerInstruction(d.TaskID, text, d, n-1)
	}
	next := m.state
	next.Decisions = append(append([]Decision{}, next.Decisions...), d)
	if m.saveEdit(next, localText("Correction saved; the original answer remains in history. Fluke receives the change.", "Corrección guardada; la respuesta original queda en el historial. Fluke recibe el cambio.")) {
		m.selected = len(m.projectDecisions()) - 1
		return m.scheduleWorkerTick()
	}
	return nil
}

func (m *model) saveWorkerInstruction(id, text string, d Decision, previous int) tea.Cmd {
	text = strings.TrimSpace(cleanAgentText(text))
	if text == "" || len(text) > 4000 {
		m.notice = localText("Write a worker message of up to 4000 bytes.", "Escribí un mensaje para el worker de hasta 4000 bytes.")
		return nil
	}
	for i, task := range m.state.Tasks {
		if task.ID != id {
			continue
		}
		if previous < 0 && task.Repo != m.repo {
			m.notice = localText("Open the worker's project before messaging it.", "Abrí el proyecto del worker antes de escribirle.")
			return nil
		}
		if err := taskScopeError(m.state, task); err != nil {
			m.notice = err.Error()
			return nil
		}
		if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
			m.notice = err.Error()
			return nil
		}
		if m.preparingTaskID == id || m.acceptingTaskID == id || m.integratingTaskID == id || m.publishingTaskID == id {
			m.notice = localText("Wait for this worker's current preparation or review operation.", "Esperá la preparación o revisión actual de este worker.")
			return nil
		}
		if task.Integration != nil || task.Publication != nil {
			m.notice = localText("This delivery has an integration or publication record. Ask Fluke for a follow-up task before changing it.", "Esta entrega tiene un registro de integración o publicación. Pedí a Fluke una tarea de seguimiento antes de cambiarla.")
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Decisions = append([]Decision{}, next.Decisions...)
		if previous >= 0 {
			if next.Decisions[previous].Continuation == "sending" {
				m.notice = localText("The previous answer is being sent. Wait before correcting it.", "La respuesta anterior se está enviando. Esperá antes de corregirla.")
				return nil
			}
			next.Decisions[previous].Continuation = "superseded"
		}
		d.Repo, d.TaskID, d.RunID, d.Seq, d.Answer = task.Repo, id, task.AgentRun, task.AgentSeq, &text
		d.HumanInstructionSeq = uint64(len(next.Decisions) + 1)
		d.Number = len(next.Decisions) + 1
		d.Continuation = "recorded"
		t := &next.Tasks[i]
		t.AcceptedTree = ""
		alive := m.sessionAlive(id)
		if alive {
			d.Continuation = "pending"
			t.Status = "running"
		} else if task.Status == "accepted" || task.Status == "awaiting_review" {
			t.Status = "interrupted"
		}
		t.AgentState = "unknown"
		t.Note = localText("Human instruction saved; Fluke and the worker share it. Scope changes still require agreement.", "Instrucción humana guardada; Fluke y el worker la comparten. Los cambios de alcance requieren acuerdo.")
		next.Decisions = append(next.Decisions, d)
		if !m.saveEdit(next, t.Note) {
			return nil
		}
		if !alive {
			m.notice += localText(" Resume the worker to apply it; nothing starts automatically.", " Retomá el worker para aplicarla; no se inicia automáticamente.")
		}
		return tea.Batch(m.continueAnsweredWorkers(), m.scheduleWorkerTick())
	}
	m.notice = fmt.Sprintf(localText("Worker %s does not exist.", "No existe el worker %s."), id)
	return nil
}

func (m *model) projectDecisions() []Decision {
	var decisions []Decision
	for _, d := range m.state.Decisions {
		if d.Repo == m.repo {
			decisions = append(decisions, d)
		}
	}
	return decisions
}
