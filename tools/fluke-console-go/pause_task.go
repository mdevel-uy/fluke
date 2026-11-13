package main

import tea "charm.land/bubbletea/v2"

func (m *model) setTaskPaused(id string, paused bool) tea.Cmd {
	for i, task := range m.state.Tasks {
		if task.ID != id {
			continue
		}
		if !paused {
			if err := taskScopeError(m.state, task); err != nil {
				m.notice = err.Error()
				return nil
			}
			if err := checkTaskSpecs(task, m.state.Goals[task.Repo]); err != nil {
				m.notice = err.Error()
				return nil
			}
		}
		if task.Repo != m.repo {
			m.notice = uiText("La tarea pertenece a otro proyecto. Cambiá de proyecto para administrarla.")
			return nil
		}
		if paused && task.Status == "accepted" {
			m.notice = uiText("La entrega ya fue aceptada; no tiene un worker que pausar.")
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].ManuallyPaused = paused
		next.Tasks[i].Paused = paused || next.PausedProjects[task.Repo]
		if !paused && (task.Status == "pending" || task.Status == "interrupted") {
			next.Tasks[i].Queued = true
		}
		if !m.saveEdit(next, uiText("Pausa de tarea guardada.")) {
			return nil
		}
		message := uiText("Tarea reanudada; los cambios y su worktree se conservan.")
		if paused {
			if m.preparing && m.preparingWorker && m.preparingTaskID == id {
				m.cancelPreparing = true
			}
			if m.sessionAlive(id) {
				m.stop(id)
			}
			if m.sessionAlive(id) {
				message = uiText("Tarea pausada; su worker sigue activo porque no se pudo detener. Cupo retenido.")
			} else {
				message = uiText("Tarea pausada. Worker detenido; cambios y worktree conservados.")
			}
		} else if next.PausedProjects[task.Repo] {
			message = uiText("Pausa individual retirada; el proyecto sigue pausado. La tarea espera su reanudación.")
		} else if task.Status == "awaiting_review" || task.Status == "accepted" {
			message = uiText("Pausa individual retirada; la entrega conserva su estado de revisión.")
		}
		cmd := tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
		m.notice = message
		return cmd
	}
	m.notice = uiText("No existe esa tarea.")
	return nil
}
