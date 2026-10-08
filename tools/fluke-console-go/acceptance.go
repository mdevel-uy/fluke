package main

import (
	tea "charm.land/bubbletea/v2"
	"context"
	"strings"
	"time"
)

type deliveryAcceptanceResult struct {
	task           Task
	tree, expected string
	err            error
}

func (m *model) latestReviewFeedback(task Task) (Decision, bool) {
	for i := len(m.state.Decisions) - 1; i >= 0; i-- {
		d := m.state.Decisions[i]
		if d.ReviewFeedback && d.TaskID == task.ID && d.RunID == task.AgentRun {
			return d, true
		}
	}
	return Decision{}, false
}

func (m *model) requestTaskChanges(id, feedback string) tea.Cmd {
	feedback = strings.TrimSpace(feedback)
	if feedback == "" || len(feedback) > 4000 {
		m.notice = uiText("Indicá los cambios pedidos en hasta 4000 bytes: :rework ID | comentario")
		return nil
	}
	for i, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if err := taskScopeError(m.state, task); err != nil {
			m.notice = err.Error()
			return nil
		}
		if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
			m.notice = err.Error()
			return nil
		}
		canRework := task.Status == "awaiting_review" || task.Status == "accepted" && task.Integration == nil
		if !canRework || m.preparingTaskID == id || m.acceptingTaskID == id || m.integratingTaskID == id || m.publishingTaskID == id {
			m.notice = uiText("Solo se piden cambios a una entrega lista para revisar.")
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		t := &next.Tasks[i]
		t.AcceptedTree, t.Integration = "", nil
		t.ReviewFeedback, t.AgentMessage, t.AgentState = feedback, uiText("Cambios pedidos por el usuario: ")+feedback, "unknown"
		t.Status, t.Queued = "interrupted", true
		alive := m.sessionAlive(id)
		if alive {
			t.Status, t.Queued = "running", false
			d := Decision{Repo: task.Repo, TaskID: id, RunID: task.AgentRun, Seq: task.AgentSeq, Question: uiText("Revisión humana de la entrega"), Answer: &feedback, Continuation: "pending", ReviewFeedback: true}
			next.Decisions = append(append([]Decision{}, next.Decisions...), d)
		}
		if !m.saveEdit(next, uiText("Cambios pedidos guardados. El worker conserva su tarea y worktree; Fluke recibe la revisión.")) {
			return nil
		}
		return tea.Batch(m.continueAnsweredWorkers(), m.drainQueue(), m.scheduleWorkerTick())
	}
	m.notice = uiText("No existe esa tarea en el proyecto actual.")
	return nil
}

// Only an explicit human action accepts a delivery. A ready report is a request
// for review, and an accepted delivery remains on its branch for human merge.
func (m *model) acceptTask(id string) tea.Cmd {
	if m.acceptingTaskID != "" || m.integratingTaskID != "" || m.publishingTaskID != "" {
		m.notice = uiText("Esperá a que termine la aceptación o integración actual.")
		return nil
	}
	for _, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if err := taskScopeError(m.state, task); err != nil && task.Status != "accepted" {
			m.notice = err.Error()
			return nil
		}
		if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
			m.notice = err.Error()
			return nil
		}
		if m.preparingTaskID == id {
			m.notice = uiText("Esperá a que termine la preparación de este worker.")
			return nil
		}
		if task.Status != "awaiting_review" && task.Status != "accepted" {
			m.notice = uiText("Solo se aceptan entregas listas para revisión. F7 muestra los cambios.")
			return nil
		}
		if m.sessionAlive(id) {
			m.stop(id)
			if m.sessionAlive(id) {
				return nil
			}
		}
		expected := ""
		if m.review.task.ID == id && !m.review.loading && m.review.err == nil {
			expected = m.review.data.Tree
		}
		m.acceptingTaskID = id
		m.notice = uiText("Verificando los archivos de la entrega antes de aceptar…")
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			tree, err := deliveryTree(ctx, task)
			return deliveryAcceptanceResult{task: task, tree: tree, expected: expected, err: err}
		}
	}
	m.notice = uiText("No existe esa tarea en el proyecto actual.")
	return nil
}

func (m *model) receiveAcceptance(v deliveryAcceptanceResult) tea.Cmd {
	if m.acceptingTaskID != v.task.ID {
		return nil
	}
	m.acceptingTaskID = ""
	if v.err != nil {
		m.notice = uiText("No se pudo aceptar: ") + v.err.Error()
		return nil
	}
	if v.expected != "" && v.expected != v.tree {
		m.notice = uiText("La entrega cambió desde el diff que revisaste. Actualizá F7 y revisala de nuevo.")
		return nil
	}
	next := m.state
	next.Tasks = append([]Task{}, next.Tasks...)
	for i, t := range next.Tasks {
		if t.ID != v.task.ID {
			continue
		}
		if t.Status != v.task.Status || t.AgentRun != v.task.AgentRun || t.AgentSeq != v.task.AgentSeq || m.sessionAlive(t.ID) {
			m.notice = uiText("La tarea cambió durante la aceptación; revisala de nuevo.")
			return nil
		}
		t.Status, t.AgentState, t.AcceptedTree = "accepted", "accepted", v.tree
		t.Queued, t.Paused, t.ManuallyPaused = false, false, false
		t.Integration = nil
		t.Note = uiText("Entrega aceptada por el usuario; cambios conservados para integración.")
		next.Tasks[i] = t
		if m.saveEdit(next, uiText("Entrega aceptada. F7 → m prepara la integración; Enter la confirma.")) {
			return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
		}
		return nil
	}
	return nil
}
