package main

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
)

func copyPausedProjects(projects map[string]bool) map[string]bool {
	copy := make(map[string]bool, len(projects)+1)
	for repo, paused := range projects {
		copy[repo] = paused
	}
	return copy
}

func (m *model) pauseProject() tea.Cmd {
	next := m.state
	next.PausedProjects = copyPausedProjects(next.PausedProjects)
	next.PausedProjects[m.repo] = true
	next.Tasks = append([]Task{}, next.Tasks...)
	var stopIDs []string
	cancelPreparation := false
	for i := range next.Tasks {
		task := &next.Tasks[i]
		if task.Repo != m.repo {
			continue
		}
		preparing := m.preparing && m.preparingWorker && m.preparingTaskID == task.ID
		if task.Status == "running" || preparing && (task.Status == "pending" || task.Status == "interrupted") {
			task.Paused = true
		}
		if preparing {
			cancelPreparation = true
		}
		if m.sessionAlive(task.ID) {
			stopIDs = append(stopIDs, task.ID)
		}
	}
	if !m.saveEdit(next, uiText("Proyecto pausado; tareas y worktrees conservados.")) {
		return nil
	}
	if cancelPreparation {
		m.cancelPreparing = true
	}
	for _, id := range stopIDs {
		m.stop(id)
	}
	live := 0
	for _, task := range m.state.Tasks {
		if task.Repo == m.repo && m.sessionAlive(task.ID) {
			live++
		}
	}
	if live > 0 {
		m.notice = fmt.Sprintf(uiText("Proyecto pausado; %d worker(s) siguen activos porque no se pudieron detener. Cupo retenido."), live)
	} else {
		m.notice = uiText("Proyecto pausado. Workers detenidos; Fluke sigue disponible para conversar.")
	}
	return m.scheduleWorkerTick()
}

func (m *model) resumeProject() tea.Cmd {
	next := m.state
	next.PausedProjects = copyPausedProjects(next.PausedProjects)
	delete(next.PausedProjects, m.repo)
	next.Tasks = append([]Task{}, next.Tasks...)
	resumed := 0
	for i := range next.Tasks {
		task := &next.Tasks[i]
		if task.Repo != m.repo || !task.Paused || task.ManuallyPaused || taskScopeError(next, *task) != nil {
			continue
		}
		task.Paused = false
		if task.Status == "pending" || task.Status == "interrupted" {
			task.Queued = true
			resumed++
		}
	}
	if !m.saveEdit(next, fmt.Sprintf(uiText("Proyecto reanudado; %d tarea(s) pausadas vuelven a la cola."), resumed)) {
		return nil
	}
	return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
}
