package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

func taskScopeError(state State, task Task) error {
	if task.GoalID != "" && task.GoalID != state.Goals[task.Repo].ID {
		return fmt.Errorf(uiText("la tarea pertenece a un objetivo anterior; :adopt %s autoriza su encargo bajo el objetivo actual"), task.ID)
	}
	return nil
}

func (m *model) saveGoalEdit(next State, success string) bool {
	next.Tasks = append([]Task{}, next.Tasks...)
	affected := map[string]string{}
	var stopIDs []string
	cancelPreparation := false
	for i := range next.Tasks {
		task := &next.Tasks[i]
		if m.state.Goals[task.Repo].ID == next.Goals[task.Repo].ID || task.Status == "accepted" || taskScopeError(next, *task) == nil {
			continue
		}
		task.Queued, task.Paused = false, true
		task.Note = fmt.Sprintf(uiText("Objetivo cambiado; tarea del alcance anterior pausada. :adopt %s autoriza conservar su encargo bajo el objetivo actual."), task.ID)
		affected[task.ID] = task.Note
		if m.preparing && m.preparingWorker && m.preparingTaskID == task.ID {
			cancelPreparation = true
		}
		if m.sessionAlive(task.ID) {
			stopIDs = append(stopIDs, task.ID)
		}
	}
	// Persist the hold with the new goal before cancelling or stopping work.
	if !m.saveEdit(next, success) {
		return false
	}
	if cancelPreparation {
		m.cancelPreparing = true
	}
	for _, id := range stopIDs {
		m.stop(id)
	}
	if len(affected) == 0 {
		return true
	}
	live := 0
	afterStops := m.state
	afterStops.Tasks = append([]Task{}, afterStops.Tasks...)
	notesChanged := false
	for i := range afterStops.Tasks {
		task := &afterStops.Tasks[i]
		note, exists := affected[task.ID]
		if !exists {
			continue
		}
		if m.sessionAlive(task.ID) {
			live++
			note += uiText(" No se pudo detener su worker; cupo retenido.")
		}
		if task.Note != note {
			task.Note = note
			notesChanged = true
		}
	}
	notice := fmt.Sprintf(uiText("%s %d tarea(s) del alcance anterior pausadas; cambios conservados."), success, len(affected))
	if live > 0 {
		notice += fmt.Sprintf(uiText(" %d worker(s) siguen activos porque no se pudieron detener; cupo retenido."), live)
	}
	if notesChanged && !m.saveEdit(afterStops, notice) {
		m.notice += uiText(" El objetivo y la pausa ya quedaron guardados.")
		return true
	}
	m.notice = notice
	return true
}

func (m *model) adoptTaskGoal(id string) tea.Cmd {
	id = strings.TrimSpace(id)
	for i, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		goal := m.state.Goals[task.Repo]
		if goal.ID == "" {
			m.notice = uiText("Acordá un objetivo antes de adoptar esta tarea.")
			return nil
		}
		if m.preparing || m.acceptingTaskID != "" || m.integratingTaskID != "" || m.publishingTaskID != "" {
			m.notice = uiText("Esperá a que termine la preparación, aceptación, integración o publicación actual.")
			return nil
		}
		if m.sessionAlive(id) {
			m.notice = uiText("Detené el worker antes de adoptar su encargo bajo otro objetivo.")
			return nil
		}
		if task.GoalID == goal.ID {
			m.notice = uiText("La tarea ya pertenece al objetivo actual.")
			return nil
		}
		if err := checkTaskSpecs(task, goal); err != nil {
			m.notice = err.Error()
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		adopted := &next.Tasks[i]
		adopted.GoalID = goal.ID
		if err := validateTaskDependencies(next, *adopted); err != nil {
			m.notice = uiText("No se pudo adoptar: ") + err.Error() + uiText(". Adoptá primero sus dependencias.")
			return nil
		}
		adopted.Queued = false
		adopted.Paused = adopted.ManuallyPaused || next.PausedProjects[task.Repo]
		adopted.Note = uiText("Encargo adoptado bajo el objetivo actual; archivos y aceptación conservados. No se inicia automáticamente.")
		m.saveEdit(next, adopted.Note)
		return nil
	}
	m.notice = uiText("Usá :adopt ID con una tarea del proyecto actual.")
	return nil
}
