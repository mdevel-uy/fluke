package main

import (
	"crypto/sha256"
	"encoding/json"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

type dependencyCheckResult struct {
	Hash    [32]byte
	Reasons map[string]string
}

func dependencyStateHash(state State) [32]byte {
	data, _ := json.Marshal(state.Tasks)
	return sha256.Sum256(data)
}

// Git reads run outside the UI loop. Recheck queued dependencies every five
// seconds so an external human merge releases the queue without spinning.
func (m *model) checkDependencies() tea.Cmd {
	if m.dependencyChecking || (m.dependencyHash == dependencyStateHash(m.state) && time.Since(m.dependencyChecked) < 5*time.Second) {
		return nil
	}
	needed := false
	for _, task := range m.state.Tasks {
		if task.Queued && !task.Paused && !m.state.PausedProjects[task.Repo] && (task.Status == "pending" || task.Status == "interrupted") && len(task.DependsOn) > 0 {
			needed = true
			break
		}
	}
	if !needed {
		return nil
	}
	snapshot := m.state
	snapshot.Tasks = append([]Task{}, snapshot.Tasks...)
	hash := dependencyStateHash(snapshot)
	m.dependencyChecking = true
	return func() tea.Msg {
		reasons := map[string]string{}
		for _, task := range snapshot.Tasks {
			if !task.Queued || task.Paused || (task.Status != "pending" && task.Status != "interrupted") || len(task.DependsOn) == 0 {
				continue
			}
			target := task.Repo
			if task.Worktree != nil {
				target = *task.Worktree
			}
			reasons[task.ID] = ""
			err := dependencyDispatchReadiness(snapshot, task, target)
			if err != nil {
				reasons[task.ID] = err.Error()
			}
		}
		return dependencyCheckResult{Hash: hash, Reasons: reasons}
	}
}

func (m *model) setDependencies(id, text string) tea.Cmd {
	for i, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if task.Status != "pending" || task.Worktree != nil || m.preparingTaskID == id {
			m.notice = uiText("Definí dependencias antes de iniciar la tarea.")
			return nil
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		next.Tasks[i].DependsOn = strings.Fields(strings.ReplaceAll(text, ",", " "))
		if err := validateTaskDependencies(next, next.Tasks[i]); err != nil {
			m.notice = err.Error()
			return nil
		}
		if !m.saveEdit(next, uiText("Dependencias guardadas; el worker espera cambios aceptados e integrados.")) {
			return nil
		}
		return tea.Batch(m.drainQueue(), m.scheduleWorkerTick())
	}
	m.notice = uiText("No existe esa tarea en este proyecto.")
	return nil
}
