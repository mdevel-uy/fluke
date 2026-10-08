package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
)

type continuationResult struct {
	TaskID, RunID string
	Seq           uint64
	DecisionIndex int
	Err           error
}

func (m *model) setContinuation(index int, value string) bool {
	next := m.state
	next.Decisions = append([]Decision{}, next.Decisions...)
	next.Decisions[index].Continuation = value
	if err := m.store.save(next); err != nil {
		m.notice = uiText("No se pudo guardar la continuación: ") + err.Error()
		return false
	}
	m.state = next
	return true
}

func (m *model) continueAnsweredWorkers() tea.Cmd {
	var commands []tea.Cmd
	inFlight := map[string]bool{}
	for _, d := range m.state.Decisions {
		if d.Continuation == "sending" {
			inFlight[d.TaskID] = true
		}
	}
	for index, d := range m.state.Decisions {
		if d.Continuation != "pending" || d.Answer == nil || inFlight[d.TaskID] {
			continue
		}
		for _, task := range m.state.Tasks {
			if task.ID != d.TaskID {
				continue
			}
			if task.AgentRun != d.RunID || (!d.ReviewFeedback && d.HumanInstructionSeq == 0 && task.AgentSeq > d.Seq) {
				m.setContinuation(index, "superseded")
				break
			}
			w := m.terminalFor(task.ID)
			if taskScopeError(m.state, task) != nil || task.Paused || m.state.PausedProjects[task.Repo] || w == nil || w.ProcessExited() || task.Worktree == nil || w.userInputPending.Load() || w.conversationPending.Load() {
				break
			}
			if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
				m.notice = err.Error()
				break
			}
			if err := atomicJSON(workerSignalPath(*task.Worktree, task.ID, task.AgentRun, "context"), workerContext(m.state, task)); err != nil {
				m.notice = localText("Worker context pending: ", "Contexto del worker pendiente: ") + err.Error()
				break
			}
			title, screen := w.agentSignals()
			if detectAgentState(task.AgentProvider, title, screen) != "idle" {
				delete(m.idleSince, task.ID)
				break
			}
			if m.idleSince[task.ID].IsZero() {
				m.idleSince[task.ID] = time.Now()
				break
			}
			if time.Since(m.idleSince[task.ID]) < 500*time.Millisecond {
				break
			}
			answerPath := workerSignalPath(*task.Worktree, task.ID, d.RunID, fmt.Sprintf("answer-%d", index+1))
			if err := atomicJSON(answerPath, d); err != nil {
				m.notice = uiText("Respuesta pendiente de entrega: ") + err.Error()
				break
			}
			if err := atomicJSON(workerSignalPath(*task.Worktree, task.ID, d.RunID, "answer"), d); err != nil {
				m.notice = uiText("Respuesta pendiente de entrega: ") + err.Error()
				break
			}
			// Persist intention before writing to the terminal. A crash here leaves
			// uncertainty; recovery never blindly resends an agent prompt.
			if !m.setContinuation(index, "sending") {
				break
			}
			inFlight[d.TaskID] = true
			commands = append(commands, func() tea.Msg {
				path, _ := json.Marshal(answerPath)
				prompt := "Fluke entregó una respuesta humana. Leé EXACTAMENTE " + string(path) + " (ruta JSON; decodificala). Este archivo conserva este mensaje y tiene prioridad sobre el mailbox genérico. Validá run_id y continuá dentro del alcance acordado; no hagas merge."
				if d.ReviewFeedback {
					prompt += " Es una revisión humana: corregí answer e incluí review_feedback_seq=" + fmt.Sprint(d.Seq) + " en tu próximo ready."
				}
				if d.HumanInstructionSeq != 0 {
					prompt += " Es una intervención o corrección: aplicá answer y leé el contexto actualizado; supersedes reemplaza la respuesta anterior. La seq de la pregunta vieja no invalida esta nueva instrucción. Incluí human_instruction_seq=" + fmt.Sprint(d.HumanInstructionSeq) + " en tu próximo ready. Consultá cambios de alcance."
				}
				err := w.sendAutomaticPrompt(task.AgentProvider, prompt)
				return continuationResult{TaskID: task.ID, RunID: d.RunID, Seq: d.Seq, DecisionIndex: index, Err: err}
			})
			break
		}
	}
	return tea.Batch(commands...)
}

func (m *model) receiveContinuation(v continuationResult) {
	for i, d := range m.state.Decisions {
		if i != v.DecisionIndex || d.TaskID != v.TaskID || d.RunID != v.RunID || d.Seq != v.Seq || d.Continuation != "sending" {
			continue
		}
		state := "sent"
		if v.Err != nil {
			state = "uncertain"
			if errors.Is(v.Err, errAutomaticDeferred) {
				state = "pending"
			}
		}
		if !m.setContinuation(i, state) {
			return
		}
		if errors.Is(v.Err, errAutomaticDeferred) {
			delete(m.idleSince, v.TaskID)
			return
		}
		delete(m.idleSince, v.TaskID)
		if v.Err != nil {
			m.notice = uiText("Envío de continuación incierto. Revisá la sesión; :resume ID reintenta explícitamente.")
		} else {
			m.notice = uiText("Respuesta enviada al worker; esperando su próximo reporte.")
		}
		return
	}
}

func (m *model) retryContinuation(id string) {
	for i := len(m.state.Decisions) - 1; i >= 0; i-- {
		d := m.state.Decisions[i]
		if d.TaskID == id && d.Answer != nil {
			for _, task := range m.state.Tasks {
				if task.ID == id {
					if err := taskScopeError(m.state, task); err != nil {
						m.notice = err.Error()
						return
					}
				}
			}
			if m.setContinuation(i, "pending") {
				m.notice = uiText("Continuación pendiente; se enviará cuando la CLI esté disponible.")
			}
			return
		}
	}
	m.notice = uiText("No hay una respuesta para esa tarea.")
}

func (m *model) queueTask(id string, queued bool) {
	for i, task := range m.state.Tasks {
		if task.ID != id {
			continue
		}
		if queued {
			if err := taskScopeError(m.state, task); err != nil {
				m.notice = err.Error()
				return
			}
		}
		if task.Status != "pending" && task.Status != "interrupted" {
			m.notice = uiText("Solo se encolan tareas pendientes o interrumpidas.")
			return
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].Queued = queued
		if m.saveEdit(next, uiText("Cola actualizada.")) && !queued && m.preparingTaskID == id && m.preparingQueued {
			m.cancelPreparing = true
		}
		return
	}
	m.notice = uiText("No existe esa tarea.")
}

func (m *model) drainQueue() tea.Cmd {
	if m.preparing || m.state.Orchestrator == nil || m.liveWorkers() >= m.state.MaxWorkers {
		return nil
	}
	check := m.checkDependencies()
	checksCurrent := m.dependencyHash == dependencyStateHash(m.state) && time.Since(m.dependencyChecked) < 5*time.Second
	for _, task := range m.state.Tasks {
		if task.Queued && !task.Paused && !m.state.PausedProjects[task.Repo] && taskScopeError(m.state, task) == nil && (task.Status == "pending" || task.Status == "interrupted") {
			if len(task.DependsOn) > 0 {
				reason, checked := m.dependencyChecks[task.ID]
				if !checked || reason != "" || !checksCurrent {
					continue
				}
			}
			launch := m.startSession(task.ID, true)
			if check != nil {
				return tea.Batch(check, launch)
			}
			return launch
		}
	}
	return check
}

func (m *model) failQueuedLaunch(id, message string) {
	for i, task := range m.state.Tasks {
		if task.ID != id {
			continue
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].Queued = false
		next.Tasks[i].Note = message
		m.saveEdit(next, uiText("Inicio fallido; tarea retirada de la cola para revisar."))
		return
	}
}

func (m *model) coordinationPending() bool {
	for repo := range m.orchestration {
		if m.sessionAlive("fluke:" + repo) {
			return true
		}
	}
	if m.liveWorkers() > 0 {
		return true
	}
	for _, d := range m.state.Decisions {
		if d.Continuation == "pending" && m.sessionAlive(d.TaskID) {
			return true
		}
	}
	for _, task := range m.state.Tasks {
		if task.Queued && !task.Paused && !m.state.PausedProjects[task.Repo] && m.state.Orchestrator != nil {
			return true
		}
	}
	return false
}
