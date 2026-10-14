package main

import "strings"

func (m *model) assignWorkerConfig(text string) {
	parts := strings.Split(text, "|")
	if len(parts) != 3 {
		m.notice = localText("Use :agent ID | codex/claude/opencode/default | model (optional).", "Usá :agent ID | codex/claude/opencode/default | modelo (opcional).")
		return
	}
	id, provider, modelName := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), strings.TrimSpace(parts[2])
	if provider != "codex" && provider != "claude" && provider != "opencode" && provider != "default" || len(modelName) > 100 || strings.ContainsAny(modelName, "\x00\r\n") {
		m.notice = localText("Choose codex, claude, opencode or default and a valid model name.", "Elegí codex, claude, opencode o default y un nombre de modelo válido.")
		return
	}
	for i, task := range m.state.Tasks {
		if task.ID != id || task.Repo != m.repo {
			continue
		}
		if m.sessionAlive(id) || m.preparingTaskID == id || task.Status == "accepted" || task.Status == "awaiting_review" {
			m.notice = localText("Change the agent on a stopped, pending worker. Existing sessions keep their model.", "Cambiá el agente de un worker detenido y pendiente. Las sesiones existentes conservan su modelo.")
			return
		}
		next := m.state
		next.Tasks = append([]Task{}, next.Tasks...)
		var config *AgentConfig
		if provider != "default" {
			a := AgentConfig{Provider: provider, Executable: provider, Model: modelName, Arguments: []string{}}
			if defaults := m.state.Orchestrator; defaults != nil && defaults.Provider == provider {
				a.Executable, a.Arguments = defaults.Executable, append([]string{}, defaults.Arguments...)
			}
			if err := validateNativeSessionConfig(a); err != nil {
				m.notice = err.Error()
				return
			}
			config = &a
		}
		next.Tasks[i].WorkerConfig = config
		m.saveEdit(next, localText("Worker agent saved. The next launch uses it; other workers keep their configuration.", "Agente guardado. Se aplica al próximo inicio; los otros workers conservan su configuración."))
		return
	}
	m.notice = localText("Select a task in this project.", "Elegí una tarea de este proyecto.")
}
